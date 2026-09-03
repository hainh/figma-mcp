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
import {
  parse,
  type Node,
  type Program,
  type Identifier,
  type MemberExpression,
  type Property,
  type MethodDefinition,
} from "acorn";

export interface ValidationProblem {
  line: number;
  column: number;
  message: string;
}

export class ValidationError extends Error {
  code: string;
  problems: ValidationProblem[];

  constructor(message: string, problems: ValidationProblem[] = []) {
    super(message);
    this.name = "ValidationError";
    this.code = "POLICY";
    this.problems = problems;
  }
}

export interface InstrumentedCode {
  code: string;
  loopsInstrumented: number;
}

const BANNED_IDENTIFIERS: ReadonlySet<string> = new Set([
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

const BANNED_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "__defineGetter__",
  "__lookupGetter__",
]);

// figma.<prop> bị cấm — plugin UI bridge không được phép chạm từ code AI
const BANNED_FIGMA_PROPS: ReadonlySet<string> = new Set([
  "ui",
  "showUI",
  "settings",
  "notify",
  "once",
  "on",
  "off",
  "emit",
  "fileKey",
  "triggerError",
]);

const LOOP_TYPES: ReadonlySet<string> = new Set([
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
]);

const BANNED_NODE_TYPES: ReadonlySet<string> = new Set([
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
 * @param source code AI generate
 * @returns code đã instrument + số loop được chèn tick
 * @throws {ValidationError} kèm danh sách problems [{ line, column, message }]
 */
export function validateAndInstrument(source: string): InstrumentedCode {
  if (typeof source !== "string" || !source.trim()) {
    throw new ValidationError("Empty code.", []);
  }

  let ast: Program;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true, // code chạy trong async wrapper
      allowReturnOutsideFunction: true, // cho phép top-level return {...}
      locations: true,
    });
  } catch (e) {
    const err = e as { loc?: { line: number; column: number }; message: string };
    const loc = err.loc ? `${err.loc.line}:${err.loc.column}` : "?";
    throw new ValidationError(`Syntax error at ${loc}: ${err.message}`, [
      { line: err.loc?.line ?? 0, column: err.loc?.column ?? 0, message: err.message },
    ]);
  }

  // ---- 1. denylist walk ----
  const problems: ValidationProblem[] = [];
  walkNodes(ast, (node) => {
    if (BANNED_NODE_TYPES.has(node.type)) {
      problems.push(at(node, `${node.type} is not allowed`));
      return;
    }

    switch (node.type) {
      case "ThisExpression":
        problems.push(at(node, "`this` is not allowed in AI code"));
        break;

      case "Identifier": {
        const id = node as Identifier;
        if (BANNED_IDENTIFIERS.has(id.name)) {
          problems.push(at(id, `Access to "${id.name}" is blocked by policy`));
        }
        break;
      }

      case "MemberExpression": {
        const m = node as MemberExpression;
        const prop = staticPropertyName(m);
        if (prop === DYNAMIC) {
          problems.push(
            at(m, "Dynamic computed member access obj[expr] is blocked; use static obj.prop or obj['prop']")
          );
          break;
        }
        if (prop && BANNED_MEMBER_NAMES.has(prop)) {
          problems.push(at(m, `Prototype-chain access ".${prop}" is blocked`));
        }
        if (
          prop &&
          BANNED_FIGMA_PROPS.has(prop) &&
          m.object.type === "Identifier" &&
          (m.object as Identifier).name === "figma"
        ) {
          problems.push(at(m, `figma.${prop} is blocked`));
        }
        break;
      }

      case "Property": {
        // { __proto__: ... } trong object literal
        const p = node as Property;
        if (!p.computed && p.key.type === "Identifier" && BANNED_MEMBER_NAMES.has(p.key.name)) {
          problems.push(at(p, `Object key "${p.key.name}" is blocked`));
        }
        break;
      }

      case "MethodDefinition": {
        const md = node as MethodDefinition;
        if (!md.computed && md.key.type === "Identifier" && BANNED_MEMBER_NAMES.has(md.key.name)) {
          problems.push(at(md, `Class member "${md.key.name}" is blocked`));
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
  // Loop nằm trong function KHÔNG async → chèn `__guard.tickSync()` (không có `await`).
  // Chèn `await` vào sync function sẽ nổ SyntaxError làm chết cả run.
  const FUNCTION_TYPES: ReadonlySet<string> = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);
  interface LoopSite {
    node: Node;
    syncScope: boolean;
  }
  const loops: LoopSite[] = [];
  (function rec(node: unknown, syncDepth: number): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) rec(child, syncDepth);
      return;
    }
    const n = node as { type?: unknown; async?: boolean } & Record<string, unknown>;
    if (typeof n.type !== "string") return;
    let depth = syncDepth;
    if (FUNCTION_TYPES.has(n.type)) {
      depth = n.async ? 0 : syncDepth + 1;
    }
    if (LOOP_TYPES.has(n.type)) loops.push({ node: node as Node, syncScope: depth > 0 });
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      rec(n[key], depth);
    }
  })(ast as unknown, 0);

  interface Edit {
    start: number;
    end: number;
    text: string;
  }
  const edits: Edit[] = [];
  for (const { node: loop, syncScope } of loops) {
    const TICK = syncScope ? " __guard.tickSync();" : " await __guard.tick();";
    const body = (loop as unknown as { body?: Node }).body;
    if (!body || body.start == null || body.end == null) continue;
    if (body.type === "BlockStatement") {
      edits.push({ start: body.start + 1, end: body.start + 1, text: TICK });
    } else {
      // do something; / for (...) stmt  → wrap thành block
      edits.push({
        start: body.start,
        end: body.end,
        text: "{" + TICK + " " + source.slice(body.start, body.end) + " }",
      });
    }
  }

  let code = source;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    code = code.slice(0, e.start) + e.text + code.slice(e.end);
  }

  return { code, loopsInstrumented: loops.length };
}

const DYNAMIC: unique symbol = Symbol("dynamic");

function staticPropertyName(memberNode: MemberExpression): string | null | typeof DYNAMIC {
  if (!memberNode.computed) {
    if (memberNode.property.type === "Identifier") return memberNode.property.name;
    if (memberNode.property.type === "PrivateIdentifier") return "#";
    return null;
  }
  const p = memberNode.property;
  if (p.type === "Literal" && typeof p.value === "string") return p.value;
  // Numeric literal index (arr[0], gradientStops[1]...) là static access an toàn → cho qua.
  if (p.type === "Literal" && typeof p.value === "number") return null;
  return DYNAMIC;
}

function at(node: Node, message: string): ValidationProblem {
  return {
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
    message,
  };
}

/** Generic AST walker — không cần acorn-walk, tự đi qua mọi object có .type */
function walkNodes(root: Program, visit: (node: Node) => void): void {
  const seen = new WeakSet<object>();
  (function rec(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) rec(child);
      return;
    }
    const maybe = node as { type?: unknown } & Record<string, unknown>;
    if (typeof maybe.type === "string") visit(node as Node);
    for (const key of Object.keys(maybe)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      rec(maybe[key]);
    }
  })(root);
}
