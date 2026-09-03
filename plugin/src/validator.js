import * as acorn from "acorn";

/**
 * AST validator + loop instrumenter (security boundary — xem architecture.md).
 *
 * Pipeline: parse → denylist checks → splice `await __guard.tick()` vào mọi loop body
 * → trả về code đã transform. Code GỐC không transform KHÔNG bao giờ được execute.
 *
 * Lưu ý design:
 *  - Wrapper `new Function` chỉ là ergonomic, KHÔNG phải sandbox. Boundary thật là file này.
 *  - Chặn accidental + phần lớn intentional escape (prototype chain, dynamic computed, import()).
 *  - Sync recursion vô hạn không instrument được bằng tick — server watchdog + user reload là lưới an toàn.
 */

export class ValidationError extends Error {
  constructor(message, problems) {
    super(message);
    this.name = "ValidationError";
    this.code = "POLICY";
    this.problems = problems || [];
  }
}

const BANNED_IDENTIFIERS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "eval",
  "Function",
  "require",
  "module",
  "exports",
  "globalThis",
  "global",
  "self",
  "window",
  "WebAssembly",
  "process",
  "importScripts",
  "Atomics",
  "SharedArrayBuffer",
]);

const BANNED_MEMBER_NAMES = new Set(["constructor", "__proto__", "prototype", "__defineGetter__", "__lookupGetter__"]);

// figma.<prop> bị cấm — plugin UI bridge không được phép chạm từ code AI
const BANNED_FIGMA_PROPS = new Set(["ui", "showUI", "settings", "notify", "once", "off", "emit", "fileKey", "triggerError"]);

const LOOP_TYPES = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);

const BANNED_NODE_TYPES = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "WithStatement",
  "LabeledStatement",
  "DebuggerStatement",
]);

/**
 * @param {string} source  code AI generate
 * @returns {{ code: string, loopsInstrumented: number }}
 * @throws {ValidationError} problems: [{ line, column, message }]
 */
export function validateAndInstrument(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new ValidationError("Empty code.", []);
  }

  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true, // code chạy trong async wrapper
      allowReturnOutsideFunction: true, // cho phép top-level return {...}
      locations: true,
    });
  } catch (e) {
    const loc = e.loc ? `${e.loc.line}:${e.loc.column}` : "?";
    throw new ValidationError(`Syntax error at ${loc}: ${e.message}`, [
      { line: e.loc?.line, column: e.loc?.column, message: e.message },
    ]);
  }

  // ---- 1. denylist walk ----
  const problems = [];
  walkNodes(ast, (node) => {
    if (BANNED_NODE_TYPES.has(node.type)) {
      problems.push(at(node, `${node.type} is not allowed`));
      return;
    }

    switch (node.type) {
      case "ThisExpression":
        problems.push(at(node, "`this` is not allowed in AI code"));
        break;

      case "Identifier":
        if (BANNED_IDENTIFIERS.has(node.name)) {
          problems.push(at(node, `Access to "${node.name}" is blocked by policy`));
        }
        break;

      case "MemberExpression": {
        const prop = staticPropertyName(node);
        if (prop === DYNAMIC) {
          problems.push(at(node, "Dynamic computed member access obj[expr] is blocked; use static obj.prop or obj['prop']"));
          break;
        }
        if (prop && BANNED_MEMBER_NAMES.has(prop)) {
          problems.push(at(node, `Prototype-chain access ".${prop}" is blocked`));
        }
        if (
          prop &&
          BANNED_FIGMA_PROPS.has(prop) &&
          node.object.type === "Identifier" &&
          node.object.name === "figma"
        ) {
          problems.push(at(node, `figma.${prop} is blocked`));
        }
        break;
      }

      case "Property": {
        // { __proto__: ... } trong object literal
        if (!node.computed && node.key && node.key.type === "Identifier" && BANNED_MEMBER_NAMES.has(node.key.name)) {
          problems.push(at(node, `Object key "${node.key.name}" is blocked`));
        }
        break;
      }

      case "MethodDefinition": {
        if (!node.computed && node.key && node.key.type === "Identifier" && BANNED_MEMBER_NAMES.has(node.key.name)) {
          problems.push(at(node, `Class member "${node.key.name}" is blocked`));
        }
        break;
      }
      default:
        break;
    }
  });

  if (problems.length) {
    throw new ValidationError(
      `Code rejected by security policy (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - line ${p.line}: ${p.message}`).join("\n"),
      problems
    );
  }

  // ---- 2. instrument loops (timeout/cancel/command budget) ----
  const loops = [];
  walkNodes(ast, (node) => {
    if (LOOP_TYPES.has(node.type)) loops.push(node);
  });

  const edits = [];
  const TICK = " await __guard.tick();";
  for (const loop of loops) {
    const body = loop.body;
    if (!body || body.start == null || body.end == null) continue;
    if (body.type === "BlockStatement") {
      edits.push({ start: body.start + 1, end: body.start + 1, text: TICK });
    } else {
      // do something; / for (...) stmt  → wrap thành block
      edits.push({ start: body.start, end: body.end, text: "{" + TICK + " " + source.slice(body.start, body.end) + " }" });
    }
  }

  let code = source;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    code = code.slice(0, e.start) + e.text + code.slice(e.end);
  }

  return { code, loopsInstrumented: loops.length };
}

const DYNAMIC = Symbol("dynamic");

function staticPropertyName(memberNode) {
  if (!memberNode.computed) {
    if (memberNode.property.type === "Identifier") return memberNode.property.name;
    if (memberNode.property.type === "PrivateIdentifier") return "#";
    return null;
  }
  const p = memberNode.property;
  if (p.type === "Literal" && typeof p.value === "string") return p.value;
  return DYNAMIC;
}

function at(node, message) {
  return { line: node.loc?.line ?? 0, column: node.loc?.column ?? 0, message };
}

/** Generic AST walker — không cần acorn-walk, tự đi qua mọi object có .type */
function walkNodes(root, visit) {
  const seen = new Set();
  (function rec(node) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) rec(child);
      return;
    }
    if (typeof node.type === "string") visit(node);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      rec(node[key]);
    }
  })(root);
}
