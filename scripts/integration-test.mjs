/**
 * Integration test: spawn a REAL figma-mcp server instance, act as a mock Figma plugin
 * (WebSocket bridge) and as a REMOTE MCP client (Streamable HTTP).
 *
 *   node scripts/integration-test.mjs
 *
 * It also asserts the id → port mapping: `figma-mcp <id>` listens on
 * MCP 10030 + id and plugin 10060 + id.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const ID = 900; // test instance id
const MCP_PORT = 10030 + ID; // 10930
const PLUGIN_PORT = 10060 + ID; // 10960
const BASE = `http://127.0.0.1:${MCP_PORT}`;

const child = spawn(process.execPath, ["server/src/index.js", String(ID)], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
child.stderr.on("data", (d) => {
  stderr += d.toString();
  if (stderr.includes("ready")) readyResolve();
});
let shuttingDown = false;
child.on("exit", (code) => {
  if (!shuttingDown && !process.exitCode) console.error(`server exited early (code ${code}):\n${stderr}`);
});

function connectWithRetry() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    (function attempt() {
      const sock = new WebSocket(`ws://127.0.0.1:${PLUGIN_PORT}`);
      sock.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("plugin bridge never came up"));
        setTimeout(attempt, 200);
      });
      sock.on("open", () => resolve(sock));
    })();
  });
}

await ready;
const ws = await connectWithRetry();
const executionRequests = [];

ws.send(JSON.stringify({ type: "hello", pluginName: "MockPlugin", protocolVersion: 1, fileName: "Mock File", autoRun: true }));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "execute") {
    executionRequests.push(msg);
    // mock: no validation, fake a result exactly like the real plugin does
    ws.send(JSON.stringify({ type: "log", id: msg.id, level: "log", args: ["mock log for:", msg.code.slice(0, 30)] }));
    ws.send(
      JSON.stringify({
        type: "result",
        id: msg.id,
        ok: true,
        value: { mocked: true },
        createdNodes: [{ id: "1:2", name: "Frame", type: "FRAME" }],
        logs: ["[log] mock done"],
        stats: { durationMs: 1 },
      }),
    );
  }
});

// ---------- remote MCP client over Streamable HTTP ----------
let sessionId = null;

async function rpc(method, params, id) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  // responses arrive as SSE ("event: message\ndata: {...}") or plain JSON; notifications return 202 with no body
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const payload = text.trim() ? JSON.parse(dataLine ? dataLine.slice(5).trim() : text) : null;
  if (!res.ok && payload && payload.error) return payload;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return payload;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function ok(cond, name) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    console.error(`  ✖ ${name}`);
    failures++;
    process.exitCode = 1;
  }
}

try {
  await sleep(300); // let the hello handshake land

  const health = await (await fetch(`${BASE}/health`)).json();
  ok(health.id === ID && health.port === PLUGIN_PORT, `/health reports id=${ID} pluginPort=${PLUGIN_PORT} (mcpPort=${MCP_PORT})`);

  const init = await rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration-test", version: "0.0.1" } },
    1,
  );
  ok(init.result?.serverInfo?.name === "figma-mcp", "initialize handshake over HTTP");
  ok(Boolean(sessionId), "server issued an Mcp-Session-Id");
  await rpc("notifications/initialized");

  const list = await rpc("tools/list", {}, 2);
  const names = list.result?.tools?.map((t) => t.name) || [];
  ok(
    JSON.stringify(names.sort()) === JSON.stringify(["cancel_execution", "execute_code", "figma_status", "get_document_info", "get_selection"]),
    "tools/list: " + names.join(", "),
  );

  const st = await rpc("tools/call", { name: "figma_status", arguments: {} }, 3);
  const status = JSON.parse(st.result.content[0].text);
  ok(status.connected === true && status.plugin.fileName === "Mock File", "figma_status shows connected mock plugin");
  ok(status.id === ID && status.port === PLUGIN_PORT, "figma_status reports the instance id + plugin port");

  const ex = await rpc("tools/call", { name: "execute_code", arguments: { code: 'const f = figma.createFrame(); return { id: "1:2" };', timeoutMs: 4000 } }, 4);
  const execResult = JSON.parse(ex.result.content[0].text);
  ok(execResult.ok === true && execResult.value?.mocked === true, "execute_code round-trip through the WS mock");
  ok(execResult.logs?.length > 0, "logs delivered");
  ok(executionRequests.length === 1 && executionRequests[0].limits.timeoutMs === 4000, "plugin received execute with limits");

  // second client session must work in parallel on the same server
  const saved = sessionId;
  sessionId = null;
  const init2 = await rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "second-client", version: "0.0.1" } },
    1,
  );
  ok(Boolean(init2.result?.serverInfo) && sessionId !== saved, "a second concurrent MCP session is accepted");
  sessionId = saved;

  shuttingDown = true;
} catch (e) {
  console.error("integration test crashed:", e);
  console.error("server stderr:", stderr);
  shuttingDown = true;
  failures++;
  process.exitCode = 1;
}

try { ws.close(); } catch {}
child.kill();
// Windows/libuv: let socket teardown finish before hard-exiting (undici keep-alive sockets would otherwise assert)
setTimeout(() => process.exit(failures ? 1 : 0), 500);
