/**
 * Sandboxed executor — chạy code ĐÃ ĐƯỢC validateAndInstrument() biến đổi.
 * KHÔNG BAO GIỜ gọi hàm này với code chưa qua validator.
 *
 * Environment inject vào `new Function`:
 *   figma    → sandbox object kế thừa figma.* (Object.create — ĐỪNG dùng new Proxy,
 *              xem buildSandboxFigma để biết lý do realm-shim "inconsistent get")
 *   console  → capture logs (stream về server + gom vào result)
 *   helpers  → createText (auto load font), ...
 *   __guard  → tick() được AST chèn vào mọi loop: timeout / cancel / budget
 */
import { validateAndInstrument, ValidationError, type ValidationProblem } from "./validator.ts";

export class ExecutionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

// ==================== types ====================

export interface Limits {
  timeoutMs: number;
  maxNodes: number;
  maxCommands: number;
}

/** Cancel-token chia sẻ với main.ts — đặt .cancelled = true để hủy ở checkpoint kế tiếp. */
export interface ControlToken {
  cancelled: boolean;
}

export interface LogEntry {
  level: string;
  args: string[];
}

export interface CreatedNode {
  id: string;
  name?: string;
  type?: string;
}

export interface RunStats {
  nodeCount: number;
  commandsUsed: number;
  loopsInstrumented?: number;
  durationMs: number;
}

export type RunResult =
  | {
      ok: true;
      value: unknown;
      createdNodes: CreatedNode[];
      logs: string[];
      stats: RunStats;
    }
  | {
      ok: false;
      code: string;
      error: string;
      problems?: ValidationProblem[];
      createdNodes: CreatedNode[];
      logs: string[];
      stats?: RunStats;
    };

export interface RunHooks {
  onLog?: (entry: LogEntry) => void;
  control?: ControlToken;
}

interface Color {
  r: number;
  g: number;
  b: number;
}

interface CreateTextOptions {
  fontName?: { family: string; style: string };
  fontSize?: number;
  color?: string | Color;
}

// ==================== runCode ====================

export async function runCode(rawCode: string, limits: Limits, hooks: RunHooks = {}): Promise<RunResult> {
  const started = Date.now();
  const logs: LogEntry[] = [];
  const createdNodes: CreatedNode[] = [];
  let commands = 0;

  const pushLog = (level: string, args: unknown[]): void => {
    const entry: LogEntry = { level, args: args.map(safeStringify) };
    logs.push(entry);
    try {
      hooks.onLog?.(entry);
    } catch {
      /* ignore */
    }
  };

  // ---- guard (timeout + cancel + budget) — control là cancel-token chia sẻ với main.ts ----
  const ctx: ControlToken = hooks.control || { cancelled: false };
  const deadline = started + (limits.timeoutMs || 5000);
  const MACROTASK_EVERY = 16; // sau N tick thì nhường về macrotask queue 1 lần
  let tickCount = 0;
  const yieldToMacrotasks: () => Promise<void> =
    typeof setTimeout === "function"
      ? () => new Promise<void>((r) => setTimeout(r, 0))
      : () => Promise.resolve();

  const guard = {
    async tick(): Promise<void> {
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
    tickSync(): void {
      if (ctx.cancelled) throw new ExecutionError("CANCELLED", "Execution was cancelled.");
      if (Date.now() > deadline) throw new ExecutionError("TIMEOUT", `Execution exceeded ${limits.timeoutMs}ms.`);
      if (++commands > (limits.maxCommands || 10000)) {
        throw new ExecutionError("BUDGET", `Command budget exceeded (max ${limits.maxCommands}).`);
      }
    },
  };

  // ---- console capture ----
  const consoleShim = {
    log: (...a: unknown[]) => pushLog("log", a),
    info: (...a: unknown[]) => pushLog("info", a),
    warn: (...a: unknown[]) => pushLog("warn", a),
    error: (...a: unknown[]) => pushLog("error", a),
    debug: (...a: unknown[]) => pushLog("debug", a),
  };

 // ---- figma sandbox: đếm create*, chặn props nhạy cảm ----
  // QUAN TRỌNG: KHÔNG bọc figma bằng `new Proxy` — trong plugin sandbox, `figma`
  // đã là proxy của Figma realm-shim, và shim enforce: get trap phải trả đúng giá trị
  // của target[prop], nếu không sẽ nổ `TypeError: proxy: inconsistent get` khi đọc BẤT KỲ
  // method create* nào (wrapCreate trả function mới ⇒ khác target) → mọi lệnh tạo node fail.
  // Giải pháp: Object.create(figma) + own properties (prototype delegation) — không proxy lồng.
  const BLOCKED_FIGMA_PROPS: ReadonlySet<string> = new Set([
    "ui",
    "showUI",
    "settings",
    "fileKey",
    "once",
    "on",
    "off",
    "emit",
    "notify",
    "triggerError",
  ]);
  // Fallback nếu Object.keys(figma) không enumerate được; list đầy đủ lấy động từ figma.
  const CREATE_METHODS_STATIC = [
    "createRectangle", "createEllipse", "createLine", "createPolygon", "createStar",
    "createText", "createFrame", "createComponent", "createComponentSet", "createSection",
    "createSlice", "createPage", "createNodeFromSvg", "createImage", "createImageAsync",
    "createVariable", "createVariableCollection", "createVariableMode",
  ] as const;
  let createdCount = 0;
  const wrapCreate = (fn: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]): unknown {
      guard.tickSync();
      const result = fn.apply(figma, args);
      const record = (nodeOrPromise: unknown): unknown => {
        try {
          const n = nodeOrPromise as { type?: string; id?: string; name?: string } | null;
          if (n && typeof n === "object" && n.type && n.id) {
            createdCount++;
            if (createdCount > (limits.maxNodes || 1000)) {
              throw new ExecutionError("BUDGET", `Node budget exceeded (max ${limits.maxNodes}).`);
            }
            createdNodes.push({ id: n.id, name: n.name, type: n.type });
          }
        } catch (e) {
          if (e instanceof ExecutionError) throw e;
        }
        return nodeOrPromise;
      };
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<unknown>).then(record);
      }
      return record(result);
    };

  const buildSandboxFigma = (): PluginAPI => {
    const sandbox = Object.create(figma) as unknown as Record<string, unknown>;
    const names = new Set<string>(CREATE_METHODS_STATIC);
    try {
      for (const k of Object.keys(figma as unknown as object)) {
        if (k.startsWith("create")) names.add(k);
      }
    } catch {
      /* không enumerate được (intercom proxy) — dùng static list */
    }
    for (const name of names) {
      const original = (figma as unknown as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;
      // Dùng defineProperty (KHÔNG dùng `sandbox[name] = ...`): các method create* trên
      // figma là read-only → assignment trong strict-mode ném "X is read-only" khi
      // prototype (figma) có own property non-writable. defineProperty bỏ qua check này.
      Object.defineProperty(sandbox, name, {
        value: wrapCreate(original as (...args: unknown[]) => unknown),
        writable: false,
        enumerable: true,
        configurable: true,
      });
    }
    for (const prop of BLOCKED_FIGMA_PROPS) {
      Object.defineProperty(sandbox, prop, {
        configurable: false,
        enumerable: false,
        get(): never {
          throw new ExecutionError("POLICY", `figma.${prop} is blocked`);
        },
        set(): never {
          throw new ExecutionError("POLICY", `figma.${prop} is blocked`);
        },
      });
    }
    return sandbox as unknown as PluginAPI;
  };

  let sandboxFigma: PluginAPI;
  try {
    sandboxFigma = buildSandboxFigma();
  } catch (e) {
    const err = e as { message?: string; stack?: string };
    pushLog("warn", [
      `figma sandbox build failed → falling back to raw figma (create*/budget tracking disabled). ` +
        `Reason: ${err?.message ?? String(e)}${err?.stack ? "\n" + String(err.stack).split("\n").slice(0, 4).join("\n") : ""}`,
    ]);
    sandboxFigma = figma; // fallback: chỉ còn validator (static) + guard — vẫn chạy được
  }

  // ---- helpers (phần "ergonomics" đáng giá nhất: font) ----
  const DEFAULT_FONT = { family: "Inter", style: "Regular" };
  const helpers = {
    /**
     * Tạo TextNode đã load font — tránh bẫy kinh điển
     * "node must load font(s) before setting the characters property".
     */
    async createText(chars: unknown, opts: CreateTextOptions = {}): Promise<TextNode> {
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
        t.fills = [{ type: "SOLID", color: normalizeColor(opts.color) } as Paint];
      }
      return t;
    },
    /** Set characters an toàn cho TextNode có sẵn (giữ font hiện tại). */
    async setAllText(node: TextNode, chars: unknown): Promise<TextNode> {
      await sandboxFigma.loadFontAsync(node.fontName as FontName);
      node.characters = String(chars);
      return node;
    },
    /** Lay ra vector color từ {r,g,b} 0-255 hoặc hex "#rrggbb". */
    color(hexOrRgb: string | Color): Color {
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
      return { ok: false, code: "POLICY", error: e.message, problems: e.problems, createdNodes, logs: logs.map(renderLog) };
    }
    const err = e as { message?: string };
    return { ok: false, code: "SYNTAX", error: String(err?.message || e), createdNodes, logs: logs.map(renderLog) };
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
    const value = await (fn as (ctx: unknown) => Promise<unknown>)({
      figma: sandboxFigma,
      console: consoleShim,
      helpers,
      __guard: guard,
    });
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
    const err = e as { name?: string; message?: string; stack?: string };
    const code =
      e instanceof ExecutionError
        ? e.code
        : String(err?.message || "").includes("Cannot find name") || /is not defined/.test(String(err?.message))
          ? "RUNTIME"
          : "RUNTIME";
    return {
      ok: false,
      code,
      error: `${err?.name || "Error"}: ${err?.message || String(e)}${err?.stack ? "\n" + String(err.stack).split("\n").slice(1, 4).join("\n") : ""}`,
      createdNodes, // node đã tạo trước khi lỗi — agent cần biết để dọn/sửa
      logs: logs.map(renderLog),
      stats: { nodeCount: createdNodes.length, commandsUsed: commands, durationMs: Date.now() - started },
    };
  }
}

/** Tạo cancel-token; truyền vào runCode qua hooks.control, đặt .cancelled = true để hủy. */
export function createControlToken(): ControlToken {
  return { cancelled: false };
}

// ---------- utils ----------

function normalizeColor(c: string | Color): Color {
  if (typeof c === "string" && /^#?[0-9a-f]{6}$/i.test(c)) {
    const h = c.replace(/^#/, "");
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  }
  if (c && typeof c === "object") {
    const scale = c.r <= 1 && c.g <= 1 && c.b <= 1 ? 1 : 255;
    return { r: c.r / scale, g: c.g / scale, b: c.b / scale };
  }
  return { r: 0, g: 0, b: 0 };
}

export function safeStringify(v: unknown): string {
  try {
    if (v === null || v === undefined) return String(v);
    const o = v as { type?: string; id?: string; name?: string };
    if (typeof v === "object" && o.type && o.id) return `[${o.type} ${o.id} "${o.name ?? ""}"]`;
    if (typeof v === "function") return "[Function]";
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function renderLog(entry: LogEntry): string {
  return `[${entry.level}] ${entry.args.join(" ")}`;
}

export function safeSerialize(value: unknown): unknown {
  try {
    const seen = new WeakSet<object>();
    return JSON.parse(
      JSON.stringify(value, (k: string, v: unknown) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
          const o = v as { type?: string; id?: string; name?: string; remove?: unknown };
          if (o.type && o.id && typeof o.remove === "function") return `[${o.type} ${o.id} "${o.name ?? ""}"]`;
        }
        if (typeof v === "function") return "[Function]";
        return v;
      })
    );
  } catch {
    return String(value);
  }
}
