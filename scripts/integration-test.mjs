/**
 * Integration test: spawn MCP server thật, giả làm plugin (WS) + giả làm MCP client (stdio).
 *   node scripts/integration-test.mjs
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 3155; // tránh va cổng dev
const child = spawn(process.execPath, ["server/src/index.js"], {
  env: { ...process.env, FIGMA_MCP_PORT: String(PORT) },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
let listeningResolve;
const listening = new Promise((r) => (listeningResolve = r));
child.stderr.on("data", (d) => {
  stderr += d.toString();
  if (stderr.includes("listening")) listeningResolve();
});
let shuttingDown = false;
child.on("exit", (code) => {
  if (!shuttingDown && !process.exitCode) console.error(`server exited early (code ${code}):\n${stderr}`);
});

function connectWithRetry() {
  return new Promise((resolve) => {
    (function attempt() {
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
      sock.on("error", () => setTimeout(attempt, 200));
      sock.on("open", () => resolve(sock));
    })();
  });
}

await listening;
const ws = await connectWithRetry();
let executionRequests = [];

ws.send(JSON.stringify({ type: "hello", pluginName: "MockPlugin", protocolVersion: 1, fileName: "Mock File" }));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "execute") {
    executionRequests.push(msg);
    // mock: validate-free, giả result như plugin thật
    ws.send(JSON.stringify({ type: "log", id: msg.id, level: "log", args: ["mock log for:", msg.code.slice(0, 30)] }));
    ws.send(
      JSON.stringify({ type: "result", id: msg.id, ok: true, value: { mocked: true }, createdNodes: [{ id: "1:2", name: "Frame", type: "FRAME" }], logs: ["[log] mock done"], stats: { durationMs: 1 } })
    );
  }
});

// ---------- MCP client over stdio (newline-delimited JSON-RPC) ----------
let buf = "";
const pendingRpc = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && pendingRpc.has(m.id)) {
      pendingRpc.get(m.id)(m);
      pendingRpc.delete(m.id);
    }
  }
});

let rpcId = 0;
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => pendingRpc.has(id) && reject(new Error("RPC timeout: " + method)), 8000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(cond, name) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    console.error(`  ✖ ${name}`);
    process.exitCode = 1;
  }
}

try {
  await sleep(300); // hello handshake

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "integration-test", version: "0.0.1" },
  });
  ok(init.result?.serverInfo?.name === "figma-mcp", "initialize handshake");
  notify("notifications/initialized", {});

  const list = await rpc("tools/list", {});
  const names = list.result?.tools?.map((t) => t.name) || [];
  ok(JSON.stringify(names.sort()) === JSON.stringify(["cancel_execution", "execute_code", "figma_status", "get_document_info", "get_selection"]), "tools/list: " + names.join(", "));

  const st = await rpc("tools/call", { name: "figma_status", arguments: {} });
  const status = JSON.parse(st.result.content[0].text);
  ok(status.connected === true && status.plugin.fileName === "Mock File", "figma_status shows connected mock plugin");

  const ex = await rpc("tools/call", { name: "execute_code", arguments: { code: 'const f = figma.createFrame(); return { id: "1:2" };', timeoutMs: 4000 } });
  const execResult = JSON.parse(ex.result.content[0].text);
  ok(execResult.ok === true && execResult.value?.mocked === true, "execute_code round-trip through WS mock");
  ok(execResult.logs?.length > 0, "logs delivered");
  ok(executionRequests.length === 1 && executionRequests[0].limits.timeoutMs === 4000, "plugin received execute with limits");

  shuttingDown = true;
  child.kill();
  ws.close();
} catch (e) {
  console.error("integration test crashed:", e);
  console.error("server stderr:", stderr);
  shuttingDown = true;
  child.kill();
  process.exitCode = 1;
}
