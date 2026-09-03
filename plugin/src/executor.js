/**
 * Sandboxed executor — chạy code ĐÃ ĐƯỢC validateAndInstrument() biến đổi.
 * KHÔNG BAO GIỜ gọi hàm này với code chưa qua validator.
 *
 * Environment inject vào `new Function`:
 *   figma    → Proxy bọc figma.* (count create*, block props)
 *   console  → capture logs (stream về server + gom vào result)
 *   helpers  → createText (auto load font), ...
 *   __guard  → tick() được AST chèn vào mọi loop: timeout / cancel / budget
 */

import { validateAndInstrument, ValidationError } from "./validator.js";

export class ExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

const HAS_PROXY = (() => {
  try {
    return typeof new Proxy({}, {}) === "object";
  } catch {
    return false;
  }
})();

/**
 * @param {string} rawCode
 * @param {{ timeoutMs:number, maxNodes:number, maxCommands:number }} limits
 * @param {{ onLog?: (entry:{level:string,args:string[]}) => void, control?: {cancelled:boolean} }} hooks
 *   control.cancelled = true → execution throw CANCELLED ở tick/create kế tiếp.
 * @returns {Promise<{ ok:true, value:any, createdNodes:any[], logs:any[], stats:any } | { ok:false, code:string, error:string, logs:any[] }>}
 */
export async function runCode(rawCode, limits, hooks = {}) {
  const started = Date.now();
  const logs = [];
  const createdNodes = [];
  let commands = 0;

  const pushLog = (level, args) => {
    const entry = { level, args: args.map(safeStringify) };
    logs.push(entry);
    try {
      hooks.onLog && hooks.onLog(entry);
    } catch {
      /* ignore */
    }
  };

  // ---- guard (timeout + cancel + budget) — control là cancel-token chia sẻ với main.js ----
  const ctx = hooks.control || { cancelled: false };
  const deadline = started + (limits.timeoutMs || 5000);
  const MACROTASK_EVERY = 16; // sau N tick thì nhường về macrotask queue 1 lần
  let tickCount = 0;
  const yieldToMacrotasks =
    typeof setTimeout === "function"
      ? () => new Promise((r) => setTimeout(r, 0))
      : () => Promise.resolve();
  const guard = {
    async tick() {
      if (ctx.cancelled) throw new ExecutionError("CANCELLED", "Execution was cancelled.");
      if (Date.now() > deadline) throw new ExecutionError("TIMEOUT", `Execution exceeded ${limits.timeoutMs}ms.`);
      if (++commands > (limits.maxCommands || 10000)) {
        throw new ExecutionError("BUDGET", `Command budget exceeded (max ${limits.maxCommands}).`);
      }
      // Quan trọng: await sukhong chi microtask se starvation macrotask queue
      // → cancel message / timer khong bao gio duoc process. Cua so yield dinh ky.
      if (++tickCount % MACROTASK_EVERY === 0) {
        await yieldToMacrotasks();
        if (ctx.cancelled) throw new ExecutionError("CANCELLED", "Execution was cancelled.");
        if (Date.now() > deadline) throw new ExecutionError("TIMEOUT", `Execution exceeded ${limits.timeoutMs}ms.`);
      } else {
        await Promise.resolve();
      }
    },
  };

  // ---- console capture ----
  const consoleShim = {
    log: (...a) => pushLog("log", a),
    info: (...a) => pushLog("info", a),
    warn: (...a) => pushLog("warn", a),
    error: (...a) => pushLog("error", a),
    debug: (...a) => pushLog("debug", a),
  };

  // ---- figma proxy: đếm create*, chặn figma.ui/showUI/settings ----
  const BLOCKED_FIGMA_PROPS = new Set(["ui", "showUI", "settings", "fileKey", "once", "off", "emit", "triggerError"]);
  let createdCount = 0;
  const wrapCreate = (prop, fn) =>
    function (...args) {
      guard.tickSync();
      const result = fn.apply(figma, args);
      const record = (nodeOrPromise) => {
        try {
          if (nodeOrPromise && typeof nodeOrPromise === "object" && nodeOrPromise.type && nodeOrPromise.id) {
            createdCount++;
            if (createdCount > (limits.maxNodes || 1000)) {
              throw new ExecutionError("BUDGET", `Node budget exceeded (max ${limits.maxNodes}).`);
            }
            createdNodes.push({ id: nodeOrPromise.id, name: nodeOrPromise.name, type: nodeOrPromise.type });
          }
        } catch (e) {
          if (e instanceof ExecutionError) throw e;
        }
      };
      if (result && typeof result.then === "function") {
        return result.then(record);
      }
      record(result);
      return result;
    };

  const sandboxFigma = HAS_PROXY
    ? new Proxy(figma, {
        get(target, prop) {
          if (typeof prop === "string" && BLOCKED_FIGMA_PROPS.has(prop)) {
            throw new ExecutionError("POLICY", `figma.${prop} is blocked`);
          }
          const val = target[prop];
          if (typeof prop === "string" && prop.startsWith("create") && typeof val === "function") {
            return wrapCreate(prop, val);
          }
          return val;
        },
      })
    : figma; // fallback: không có Proxy thì chỉ còn validator + guard

  // guard.tickSync cho create* (không chờ await)
  guard.tickSync = () => {
    if (ctx.cancelled) throw new ExecutionError("CANCELLED", "Execution was cancelled.");
    if (Date.now() > deadline) throw new ExecutionError("TIMEOUT", `Execution exceeded ${limits.timeoutMs}ms.`);
    if (++commands > (limits.maxCommands || 10000)) {
      throw new ExecutionError("BUDGET", `Command budget exceeded (max ${limits.maxCommands}).`);
    }
  };

  // ---- helpers (phần "ergonomics" đáng giá nhất: font) ----
  const DEFAULT_FONT = { family: "Inter", style: "Regular" };
  const helpers = {
    /**
     * Tạo TextNode đã load font — tránh bẫy kinh điển
     * "node must load font(s) before setting the characters property".
     */
    async createText(chars, opts = {}) {
      const t = sandboxFigma.createText();
      const fontName = opts.fontName || DEFAULT_FONT;
      try {
        await sandboxFigma.loadFontAsync(fontName);
        t.fontName = fontName;
      } catch {
        await sandboxFigma.loadFontAsync(DEFAULT_FONT);
        t.fontName = DEFAULT_FONT;
      }
      t.characters = String(chars ?? "");
      if (opts.fontSize) {
        try {
          t.fontSize = opts.fontSize;
        } catch {
          /* mixed font sau khi set characters — bỏ qua */
        }
      }
      if (opts.color) {
        t.fills = [{ type: "SOLID", color: normalizeColor(opts.color) }];
      }
      return t;
    },
    /** Set characters an toàn cho TextNode có sẵn (giữ font hiện tại). */
    async setAllText(node, chars) {
      await sandboxFigma.loadFontAsync(node.fontName);
      node.characters = String(chars);
      return node;
    },
    /** Lay ra vector color từ {r,g,b} 0-255 hoặc hex "#rrggbb". */
    color(hexOrRgb) {
      return normalizeColor(hexOrRgb);
    },
    DEFAULT_FONT,
  };

  // ---- validate + instrument (LẠI MỘT LẦN NỮA, ngay trước khi chạy — defense in depth) ----
  let prepared;
  try {
    prepared = validateAndInstrument(rawCode);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { ok: false, code: "POLICY", error: e.message, problems: e.problems, logs: logs.map(renderLog) };
    }
    return { ok: false, code: "SYNTAX", error: String(e?.message || e), logs: logs.map(renderLog) };
  }

  // ---- execute ----
  try {
    const fn = new Function(
      "__ctx",
      `"use strict";
       const { figma, console, helpers, __guard } = __ctx;
       return (async () => {
${prepared.code}
       })();`
    );
    const value = await fn({ figma: sandboxFigma, console: consoleShim, helpers, __guard: guard });
    return {
      ok: true,
      value: safeSerialize(value),
      createdNodes,
      logs: logs.map(renderLog),
      stats: {
        nodeCount: createdNodes.length,
        commandsUsed: commands,
        loopsInstrumented: prepared.loopsInstrumented,
        durationMs: Date.now() - started,
      },
    };
  } catch (e) {
    const code =
      e instanceof ExecutionError
        ? e.code
        : String(e?.message || "").includes("Cannot find name") || /is not defined/.test(String(e?.message))
          ? "RUNTIME"
          : "RUNTIME";
    return {
      ok: false,
      code,
      error: `${e?.name || "Error"}: ${e?.message || String(e)}${e?.stack ? "\n" + String(e.stack).split("\n").slice(1, 4).join("\n") : ""}`,
      createdNodes, // node đã tạo trước khi lỗi — agent cần biết để dọn/sửa
      logs: logs.map(renderLog),
      stats: { nodeCount: createdNodes.length, commandsUsed: commands, durationMs: Date.now() - started },
    };
  }
}

/** Tạo cancel-token; truyền vào runCode qua hooks.control, đặt .cancelled = true để hủy. */
export function createControlToken() {
  return { cancelled: false };
}

// ---------- utils ----------

function normalizeColor(c) {
  if (typeof c === "string" && /^#?[0-9a-f]{6}$/i.test(c)) {
    const h = c.replace(/^#/, "");
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
  }
  if (c && typeof c === "object") {
    const scale = c.r <= 1 && c.g <= 1 && c.b <= 1 ? 1 : 255;
    return { r: c.r / scale, g: c.g / scale, b: c.b / scale };
  }
  return { r: 0, g: 0, b: 0 };
}

export function safeStringify(v) {
  try {
    if (v === null || v === undefined) return String(v);
    if (typeof v === "object" && v.type && v.id) return `[${v.type} ${v.id} "${v.name ?? ""}"]`;
    if (typeof v === "function") return "[Function]";
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function renderLog(entry) {
  return `[${entry.level}] ${entry.args.join(" ")}`;
}

export function safeSerialize(value) {
  try {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(value, (k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
          if (v.type && v.id && typeof v.remove === "function") return `[${v.type} ${v.id} "${v.name ?? ""}"]`;
        }
        if (typeof v === "function") return "[Function]";
        return v;
      })
    );
  } catch {
    return String(value);
  }
}
