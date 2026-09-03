/**
 * Figma Plugin — Main Thread
 *
 * Nhận message từ UI (WS bridge + approval), validate + execute code AI, trả result về UI.
 * Protocol: xem architecture.md § Quy tắc protocol.
 */
import { runCode, createControlToken, safeStringify } from "./executor.js";
import { validateAndInstrument } from "./validator.js";

const PROTOCOL_VERSION = 1;
const PLUGIN_NAME = "Figma MCP Connector";
const PLUGIN_VERSION = "0.1.0";

figma.showUI(__html__, { width: 380, height: 520 });

/** Auto-run OFF mặc định — human-in-the-loop (architecture.md § Approval UX) */
let autoRun = false;

/** execId → { control, promise? } — các run đang chờ approval hoặc đang chạy */
const inFlight = new Map();

let helloSent = false;

// ================= UI → MAIN =================
figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.kind) {
    case "ws-connected":
    case "ui-ready":
    case "ws-reconnected": {
      // UI mở / reconnect WS thành công → gửi (hoặc gửi lại) hello với metadata file.
      // Server cần hello mới vì connection WS mới = session mới.
      sendToWs(buildHello());
      return;
    }

    case "ws-closed": {
      helloSent = false;
      return;
    }

    case "ws-message": {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      handleServerMessage(data);
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

    case "set-autorun": {
      autoRun = Boolean(msg.value);
      notifyUi({ kind: "autorun-changed", value: autoRun });
      return;
    }
  }
};

// ================= SERVER → PLUGIN (qua UI) =================
function handleServerMessage(msg) {
  switch (msg.type) {
    case "hello": {
      if (msg.role === "server") {
        if (msg.ok === false && msg.code === "BUSY") {
          notifyUi({ kind: "connection", status: "busy", message: "Another plugin instance already holds the connection." });
          helloSent = false;
        } else if (msg.ok === true) {
          helloSent = true;
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
          sendResult({ type: "result", id: msg.id, ok: false, code: "CANCELLED", error: "Cancelled before approval.", logs: [] });
        } else {
          run.control.cancelled = true;
        }
      }
      return;
    }

    case "pong":
      return; // UI tự xử lý heartbeat
  }
}

function onExecuteRequest(msg) {
  const { id, code, limits } = msg;
  if (!id || typeof code !== "string") return;
  if (inFlight.has(id)) return; // duplicate id

  const control = createControlToken();
  const run = {
    id,
    code,
    limits: normalizeLimits(limits),
    control,
    state: "pending",
  };
  inFlight.set(id, run);

  // Pre-validate nhanh để hiện lỗi sớm trong UI + tiết kiệm round-trip approval cho code rác
  let preValid = true;
  try {
    validateAndInstrument(code);
  } catch (e) {
    preValid = false;
    inFlight.delete(id);
    sendResult({ type: "result", id, ok: false, code: e.code || "POLICY", error: String(e.message || e), logs: [] });
  }
  if (!preValid) return;

  if (autoRun) {
    run.state = "running";
    startExecution(run);
  } else {
    run.state = "awaiting-approval";
    notifyUi({ kind: "approval-request", id, code, limits: run.limits, file: figma.root.name });
  }
}

async function startExecution(run) {
  const { id, code, limits, control } = run;
  try {
    const result = await runCode(code, limits, {
      control,
      onLog: (entry) => sendResult({ type: "log", id, level: entry.level, args: entry.args }),
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
    notifyUi({ kind: "run-finished", id, ok: false, summary: String(e && e.message) });
  }
}

// ================= helpers =================
function buildHello() {
  return {
    type: "hello",
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    fileKey: typeof figma.fileKey === "string" ? figma.fileKey : null,
    fileName: figma.root.name,
    autoRun,
  };
}

function normalizeLimits(limits = {}) {
  const num = (v, dflt, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
  };
  return {
    timeoutMs: num(limits.timeoutMs, 5000, 1000, 60000),
    maxNodes: num(limits.maxNodes, 1000, 1, 10000),
    maxCommands: num(limits.maxCommands, 10000, 1, 100000),
  };
}

function sendToWs(payload) {
  notifyUi({ kind: "to-ws", payload: JSON.stringify(payload) });
}

function sendResult(payload) {
  sendToWs(payload);
}

function notifyUi(payload) {
  try {
    figma.ui.postMessage(payload);
  } catch {
    /* UI có thể đã đóng */
  }
}
