import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

/**
 * FigmaBridge — WebSocket hub between the MCP server and the Figma plugin.
 *
 * Protocol (see architecture.md § protocol rules):
 *  - hello handshake, sent by the plugin on connect (fileKey/fileName/protocolVersion)
 *  - ping/pong heartbeat: plugin pings every 3s, disconnect after 10s of silence
 *  - execute → log (streaming) → result (a single shape, ok true/false)
 *  - cancel: fire-and-forget from the server
 *  - ONE active plugin connection per server instance at a time. When a new plugin
 *    connects it REPLACES the previous one (last-man-wins): the old socket is notified
 *    with code "REPLACED" and closed with close code REPLACE_CLOSE_CODE, so its UI stops
 *    auto-reconnecting and shows a "replaced" status instead of kicking the new session.
 *    Run several servers with `figma-mcp <id>` → plugin port 10060 + id.
 */

const PROTOCOL_VERSION = 1;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const WATCHDOG_GRACE_MS = 2_000; // server-side watchdog = timeoutMs + grace
/** Close code telling the plugin UI it was intentionally replaced → do NOT auto-reconnect. */
const REPLACE_CLOSE_CODE = 4001;

export class FigmaBridge {
  constructor({ port = 10060, id = 0 } = {}) {
    this.port = port;
    this.id = id;
    this.wss = null;
    this.client = null; // active WebSocket
    this.hello = null; // plugin metadata
    this.pending = new Map(); // execId -> { resolve, reject, timer, logs }
    this._seq = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} already in use — stop the other instance, or use another id / FIGMA_MCP_PLUGIN_PORT`));
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
      id: this.id,
    };
  }

  /**
   * Send code to the plugin and wait for the result (single shape: { ok, value } | { ok:false, code, error, logs }).
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
      // Server-side watchdog: cuts off runs when the plugin hangs / disconnects mid-flight.
      // (The REAL timeout is enforced by the plugin via loop instrumentation — the watchdog is only a safety net.)
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

  /**
   * Ask the plugin to roll back the last N execute_code runs (figma.triggerUndo,
   * one commitUndo group per run). Resolves with the plugin's result shape.
   */
  undo(steps = 1) {
    if (!this.connected) {
      return Promise.resolve({
        ok: false,
        code: "NO_PLUGIN",
        error: "Figma plugin is not connected. Open Figma, run the 'Figma MCP Connector' plugin, and confirm its UI shows 'Connected'.",
      });
    }
    const id = `undo_${++this._seq}_${randomUUID().slice(0, 8)}`;
    const msg = { type: "undo", id, steps: clampInt(steps, 1, 100, 1) };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        resolve({ ok: false, code: "DISCONNECTED", error: "Plugin did not respond to undo (watchdog).", logs: [] });
      }, WATCHDOG_GRACE_MS + 3_000);
      this.pending.set(id, { resolve, timer, logs: [] });
      this._safeSend(msg);
    });
  }

  stop() {
    if (this.client) this._teardownHeartbeat(this.client);
    for (const [, entry] of this.pending) clearTimeout(entry.timer);
    this.pending.clear();
    if (this.client) this.client.close();
    if (this.wss) this.wss.close();
  }

  // ---------- internals ----------

  _onConnection(ws) {
    // Per-connection heartbeat bookkeeping lives on the socket itself so that a replaced
    // connection can never clobber the state of the one that just took over.
    ws.__lastPongAt = Date.now();
    ws.__heartbeat = null;

    if (this.connected && this.client !== ws) {
      // Last-man-wins: accept the newcomer and evict the previous plugin connection.
      console.error("[figma-mcp] new plugin connected — replacing the previous connection");
      this._evictClient("REPLACED");
    }

    this.client = ws;
    this.hello = null;
    console.error("[figma-mcp] plugin socket opened, waiting for hello");

    ws.__heartbeat = setInterval(() => {
      // Only the socket that is still the active client can trigger a heartbeat drop.
      if (this.client !== ws) {
        this._teardownHeartbeat(ws);
        return;
      }
      if (Date.now() - ws.__lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        console.error("[figma-mcp] heartbeat lost, dropping plugin connection");
        ws.terminate();
      }
    }, 3_000);

    ws.on("message", (raw) => this._onMessage(ws, raw));
    ws.on("close", () => this._onClose(ws));
    ws.on("error", () => this._onClose(ws));
  }

  /**
   * Notify the currently-active client that it has been replaced and close its socket.
   * Uses REPLACE_CLOSE_CODE so the plugin UI knows NOT to auto-reconnect (avoids a loop).
   */
  _evictClient(code) {
    const old = this.client;
    if (!old) return;
    // Detach first so the close event doesn't wipe the state of the incoming session.
    this.client = null;
    this._teardownHeartbeat(old);
    try {
      if (old.readyState === 1 /* OPEN */) {
        old.send(JSON.stringify({ type: "hello", role: "server", protocolVersion: PROTOCOL_VERSION, ok: false, code }));
      }
    } catch {
      /* socket may already be gone */
    }
    try {
      old.close(REPLACE_CLOSE_CODE, "replaced");
    } catch {
      try { old.terminate(); } catch { /* already closed */ }
    }
    this.hello = null;
    this._failPending("Another plugin instance connected and took over this server.");
  }

  _teardownHeartbeat(ws) {
    if (ws && ws.__heartbeat) {
      clearInterval(ws.__heartbeat);
      ws.__heartbeat = null;
    }
  }

  /** Resolve all in-flight executions with a DISCONNECTED-style error. */
  _failPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: "DISCONNECTED", error, logs: entry.logs });
      this.pending.delete(id);
    }
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // malformed message — ignore
    }
    if (ws !== this.client) return;
    ws.__lastPongAt = Date.now();

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
        if (!entry) return; // already resolved by the watchdog — ignore
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
    this._teardownHeartbeat(ws);
    if (ws !== this.client) return; // a replaced/duplicate socket — leave the active session alone
    this.client = null;
    this.hello = null;
    this._failPending("Plugin disconnected while execution was running.");
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
