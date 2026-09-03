import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

/**
 * FigmaBridge — WebSocket hub giữa MCP Server và Figma Plugin.
 *
 * Protocol (xem architecture.md § Quy tắc protocol):
 *  - hello handshake, plugin gửi khi connect (kèm fileKey/fileName/protocolVersion)
 *  - ping/pong heartbeat: plugin ping mỗi 3s, disconnect sau 10s im lặng
 *  - execute → log (streaming) → result (1 shape duy nhất, ok true/false)
 *  - cancel: fire-and-forget từ server
 *  - MVP: 1 plugin connection tại 1 thời điểm, connection thứ 2 bị từ chối BUSY
 */

const PROTOCOL_VERSION = 1;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const WATCHDOG_GRACE_MS = 2_000; // server-side watchdog = timeoutMs + grace

export class FigmaBridge {
  constructor({ port = 3055 } = {}) {
    this.port = port;
    this.wss = null;
    this.client = null; // WebSocket đang active
    this.hello = null; // plugin metadata
    this.pending = new Map(); // execId -> { resolve, reject, timer, logs }
    this.lastPongAt = 0;
    this.heartbeatTimer = null;
    this._seq = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} already in use — tắt instance khác hoặc đổi FIGMA_MCP_PORT`));
        } else {
          reject(err);
        }
      });
      this.wss.on("listening", () => {
        console.error(`[figma-mcp] WebSocket bridge listening on ws://localhost:${this.port}`);
        resolve();
      });
      this.wss.on("connection", (ws) => this._onConnection(ws));
    });
  }

  get connected() {
    return Boolean(this.client && this.client.readyState === 1 /* OPEN */);
  }

  status() {
    return {
      connected: this.connected,
      plugin: this.hello,
      pendingExecutions: [...this.pending.keys()],
      port: this.port,
    };
  }

  /**
   * Gửi code sang plugin, chờ result (1 shape: { ok, value } | { ok:false, code, error, logs }).
   */
  execute(code, limits = {}) {
    if (!this.connected) {
      return Promise.resolve({
        ok: false,
        code: "NO_PLUGIN",
        error:
          "Figma plugin is not connected. Open Figma, run the 'Figma MCP Connector' plugin, and confirm its UI shows 'Connected'.",
      });
    }
    const id = `exec_${++this._seq}_${randomUUID().slice(0, 8)}`;
    const msg = {
      type: "execute",
      id,
      code,
      limits: {
        timeoutMs: clampInt(limits.timeoutMs, 1_000, 60_000, 5_000),
        maxNodes: clampInt(limits.maxNodes, 1, 10_000, 1_000),
        maxCommands: clampInt(limits.maxCommands, 1, 100_000, 10_000),
      },
    };

    return new Promise((resolve) => {
      // Server-side watchdog: cắt trong trường hợp plugin treo / mất kết nối giữa chừng.
      // (Timeout THẬT do plugin enforce bằng loop instrumentation — watchdog chỉ là lưới an toàn.)
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this._safeSend({ type: "cancel", id });
        resolve({
          ok: false,
          code: "DISCONNECTED",
          error: `Plugin did not respond within ${msg.limits.timeoutMs + WATCHDOG_GRACE_MS}ms (watchdog). It may be hung or disconnected.`,
          logs: entry.logs,
        });
      }, msg.limits.timeoutMs + WATCHDOG_GRACE_MS);

      this.pending.set(id, { resolve, timer, logs: [] });
      this._safeSend(msg);
    });
  }

  cancel(execId) {
    if (!this.connected) return false;
    this._safeSend({ type: "cancel", id: execId });
    return true;
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [, entry] of this.pending) clearTimeout(entry.timer);
    this.pending.clear();
    if (this.client) this.client.close();
    if (this.wss) this.wss.close();
  }

  // ---------- internals ----------

  _onConnection(ws) {
    if (this.connected) {
      // MVP: một kết nối tại một thời điểm
      ws.send(JSON.stringify({ type: "hello", role: "server", protocolVersion: PROTOCOL_VERSION, ok: false, code: "BUSY" }));
      setTimeout(() => ws.close(4000, "busy"), 200);
      return;
    }
    this.client = ws;
    this.lastPongAt = Date.now();
    console.error("[figma-mcp] plugin socket opened, waiting for hello");

    this.heartbeatTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        console.error("[figma-mcp] heartbeat lost, dropping plugin connection");
        ws.terminate();
      }
    }, 3_000);

    ws.on("message", (raw) => this._onMessage(ws, raw));
    ws.on("close", () => this._onClose(ws));
    ws.on("error", () => this._onClose(ws));
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // message rác — bỏ qua
    }
    if (ws !== this.client) return;
    this.lastPongAt = Date.now();

    switch (msg.type) {
      case "hello": {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this._safeSend({ type: "hello", role: "server", protocolVersion: PROTOCOL_VERSION, ok: false, code: "VERSION_MISMATCH" });
          return;
        }
        this.hello = {
          pluginName: msg.pluginName,
          pluginVersion: msg.pluginVersion,
          fileKey: msg.fileKey ?? null,
          fileName: msg.fileName ?? null,
          autoRun: msg.autoRun === true,
        };
        this._safeSend({ type: "hello", role: "server", protocolVersion: PROTOCOL_VERSION, ok: true });
        console.error(`[figma-mcp] plugin connected: ${this.hello.pluginName} (${this.hello.fileName ?? "no file"})`);
        return;
      }
      case "ping":
        this._safeSend({ type: "pong", t: msg.t });
        return;
      case "log": {
        const entry = this.pending.get(msg.id);
        if (entry && Array.isArray(msg.args)) entry.logs.push(`[${msg.level || "log"}] ${msg.args.join(" ")}`);
        return;
      }
      case "result": {
        const entry = this.pending.get(msg.id);
        if (!entry) return; // đã resolve bởi watchdog — ignore
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        const logs = (Array.isArray(msg.logs) && msg.logs.length ? msg.logs : entry.logs);
        entry.resolve({ ...msg, logs });
        return;
      }
      default:
        return;
    }
  }

  _onClose(ws) {
    if (ws !== this.client) return;
    this.client = null;
    this.hello = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        ok: false,
        code: "DISCONNECTED",
        error: "Plugin disconnected while execution was running.",
        logs: entry.logs,
      });
      this.pending.delete(id);
    }
    console.error("[figma-mcp] plugin disconnected");
  }

  _safeSend(obj) {
    if (!this.connected) return false;
    try {
      this.client.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}
