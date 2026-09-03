/**
 * Figma Plugin — Main Thread
 *
 * Receives messages from the UI (WS bridge + approval), validates and executes AI-generated
 * code, then returns the result to the UI. Protocol: see architecture.md (protocol rules).
 */
import { runCode, createControlToken, safeStringify, type ControlToken, type Limits } from "./executor.ts";
import { validateAndInstrument, ValidationError } from "./validator.ts";

const PROTOCOL_VERSION = 1;
const PLUGIN_NAME = "Figma MCP Connector";
const PLUGIN_VERSION = "0.1.0";
/** Default WebSocket port of the MCP server (plugin side) = 10060 + serverId. */
const DEFAULT_WS_PORT = 10060;
const WS_PORT_KEY = "wsPort";

// ==================== protocol types ====================

/** Message UI → main (WebSocket bridge events + approval). */
type UiToMainMessage =
  | { kind: "ws-connected" }
  | { kind: "ui-ready" }
  | { kind: "ws-reconnected" }
  | { kind: "ws-closed" }
  | { kind: "ws-message"; data: string }
  | { kind: "approval"; id: string; approved: boolean }
  | { kind: "set-port"; value: unknown };

/** Message server → plugin (over the UI websocket). */
type ServerMessage =
  | { type: "hello"; role?: string; ok?: boolean; code?: string; protocolVersion?: number }
  | { type: "execute"; id: string; code: string; limits?: Partial<Limits> }
  | { type: "cancel"; id: string }
  | { type: "pong" };

/** Message main → UI. */
type UiPayload = Record<string, unknown>;

/** Result payload plugin → server (via UI "to-ws"). */
interface ResultPayload {
  type: "result" | "log";
  id: string;
  ok?: boolean;
  value?: unknown;
  createdNodes?: unknown[];
  code?: string;
  error?: string;
  level?: string;
  args?: string[];
  stats?: unknown;
  logs: unknown[];
}

type RunState = "pending" | "awaiting-approval" | "running";

interface InFlightRun {
  id: string;
  code: string;
  limits: Limits;
  control: ControlToken;
  state: RunState;
}

figma.showUI(__html__, { width: 380, height: 520 });

/** Bridge port chosen by the user (persisted via clientStorage) — the UI connects to this port. */
let wsPort = DEFAULT_WS_PORT;

/** Auto-run is always ON — no toggle in the UI, every run executes immediately. */
const autoRun = true;

figma.clientStorage
  .getAsync(WS_PORT_KEY)
  .then((v) => {
    const port = normalizePort(v);
    if (port !== wsPort) wsPort = port;
    // The UI waits for this config to know which port to connect to (fallback: DEFAULT_WS_PORT in the UI)
    notifyUi({ kind: "config", port: wsPort, defaultPort: DEFAULT_WS_PORT });
  })
  .catch(() => {
    notifyUi({ kind: "config", port: wsPort, defaultPort: DEFAULT_WS_PORT });
  });

/** execId → run that is awaiting approval or currently running */
const inFlight = new Map<string, InFlightRun>();

// ================= UI → MAIN =================
figma.ui.onmessage = async (msg: UiToMainMessage) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.kind) {
    case "ws-connected":
    case "ui-ready":
    case "ws-reconnected": {
      // UI opened / reconnected the WS successfully → send (or re-send) hello with file metadata.
      // The server needs a fresh hello because a new WS connection = a new session.
      sendToWs(buildHello());
      return;
    }

    case "ws-closed": {
      return;
    }

    case "ws-message": {
      let data: unknown;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      handleServerMessage(data as ServerMessage);
      return;
    }

    case "approval": {
      // { kind:'approval', id, approved:boolean }
      const run = inFlight.get(msg.id);
      if (!run) return;
      if (run.state !== "awaiting-approval") return;
      if (msg.approved) {
        run.state = "running";
        notifyUi({ kind: "run-started", id: msg.id });
        startExecution(run);
      } else {
        inFlight.delete(msg.id);
        sendResult({
          type: "result",
          id: msg.id,
          ok: false,
          code: "REJECTED",
          error: "User rejected execution in the plugin UI.",
          logs: [],
        });
      }
      return;
    }

    case "set-port": {
      const next = normalizePort(msg.value);
      wsPort = next;
      notifyUi({ kind: "port-changed", port: next, defaultPort: DEFAULT_WS_PORT });
      figma.clientStorage.setAsync(WS_PORT_KEY, next).catch(() => {});
      return;
    }
  }
};

// ================= SERVER → PLUGIN (qua UI) =================
function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "hello": {
      if (msg.role === "server") {
        if (msg.ok === false && msg.code === "BUSY") {
          notifyUi({
            kind: "connection",
            status: "busy",
            message: "Another plugin instance already holds the connection.",
          });
        } else if (msg.ok === true) {
          notifyUi({ kind: "connection", status: "connected", server: `protocol v${msg.protocolVersion}` });
        }
      }
      return;
    }

    case "execute": {
      onExecuteRequest(msg);
      return;
    }

    case "cancel": {
      const run = inFlight.get(msg.id);
      if (run) {
        if (run.state === "awaiting-approval") {
          inFlight.delete(msg.id);
          sendResult({
            type: "result",
            id: msg.id,
            ok: false,
            code: "CANCELLED",
            error: "Cancelled before approval.",
            logs: [],
          });
        } else {
          run.control.cancelled = true;
        }
      }
      return;
    }

    case "pong":
      return; // the UI handles heartbeat itself
  }
}

function onExecuteRequest(msg: Extract<ServerMessage, { type: "execute" }>): void {
  const { id, code, limits } = msg;
  if (!id || typeof code !== "string") return;
  if (inFlight.has(id)) return; // duplicate id

  const control = createControlToken();
  const run: InFlightRun = {
    id,
    code,
    limits: normalizeLimits(limits),
    control,
    state: "pending",
  };
  inFlight.set(id, run);

  // Quick pre-validation to surface errors early in the UI + save an approval round-trip for garbage code
  try {
    validateAndInstrument(code);
  } catch (e) {
    inFlight.delete(id);
    const err = e as ValidationError;
    sendResult({
      type: "result",
      id,
      ok: false,
      code: err.code || "POLICY",
      error: String(err.message || e),
      logs: [],
    });
    return;
  }

  if (autoRun) {
    run.state = "running";
    startExecution(run);
  } else {
    run.state = "awaiting-approval";
    notifyUi({ kind: "approval-request", id, code, limits: run.limits, file: figma.root.name });
  }
}

async function startExecution(run: InFlightRun): Promise<void> {
  const { id, code, limits, control } = run;
  try {
    const result = await runCode(code, limits, {
      control,
      onLog: (entry) => sendResult({ type: "log", id, level: entry.level, args: entry.args, logs: [] }),
    });
    inFlight.delete(id);
    sendResult({
      type: "result",
      id,
      ok: result.ok === true,
      value: result.ok ? result.value : undefined,
      createdNodes: result.createdNodes || [],
      code: result.ok ? undefined : result.code,
      error: result.ok ? undefined : result.error,
      stats: result.stats,
      logs: result.logs || [],
    });
    notifyUi({ kind: "run-finished", id, ok: result.ok === true, summary: result.ok ? "ok" : result.error });
  } catch (e) {
    inFlight.delete(id);
    sendResult({ type: "result", id, ok: false, code: "RUNTIME", error: safeStringify(e), logs: [] });
    const err = e as { message?: string };
    notifyUi({ kind: "run-finished", id, ok: false, summary: String(err?.message ?? e) });
  }
}

// ================= helpers =================
function buildHello(): UiPayload {
  return {
    type: "hello",
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    // fileKey throws/null under documentAccess "dynamic-page" until pages are loaded — never let it kill the handshake
    fileKey: safeFileKey(),
    fileName: figma.root.name,
    autoRun,
  };
}

function safeFileKey(): string | null {
  try {
    return typeof figma.fileKey === "string" ? figma.fileKey : null;
  } catch {
    return null;
  }
}

function normalizePort(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WS_PORT;
  return Math.max(1, Math.min(65535, Math.round(n)));
}

function normalizeLimits(limits: Partial<Limits> = {}): Limits {
  const num = (v: unknown, dflt: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
  };
  return {
    timeoutMs: num(limits.timeoutMs, 5000, 1000, 60000),
    maxNodes: num(limits.maxNodes, 1000, 1, 10000),
    maxCommands: num(limits.maxCommands, 10000, 1, 100000),
  };
}

function sendToWs(payload: unknown): void {
  notifyUi({ kind: "to-ws", payload: JSON.stringify(payload) });
}

function sendResult(payload: ResultPayload): void {
  sendToWs(payload);
}

function notifyUi(payload: UiPayload): void {
  try {
    figma.ui.postMessage(payload);
  } catch {
    /* the UI may already be closed */
  }
}

