#!/usr/bin/env node
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FigmaBridge } from "./bridge.js";

const require = createRequire(import.meta.url);
const PKG_VERSION = (() => {
  try {
    return require("../package.json").version;
  } catch {
    return "0.0.0";
  }
})();

// ---------- Ports ----------
export const DEFAULT_ID = 0;
export const BASE_MCP_PORT = 10030; // MCP client (remote, Streamable HTTP)
export const BASE_PLUGIN_PORT = 10060; // Figma plugin (WebSocket bridge)

// ---------- CLI ----------
const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  console.log(PKG_VERSION);
  process.exit(0);
}
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`figma-mcp — MCP server bridging AI agents to the Figma plugin runtime.

Usage: figma-mcp [id] [options]

Arguments:
  id                     Numeric instance id (default: ${DEFAULT_ID}).
                         Both listening ports are offset by this id, so several
                         servers can run at the same time:
                           figma-mcp      → MCP ${BASE_MCP_PORT} / plugin ${BASE_PLUGIN_PORT}
                           figma-mcp 1    → MCP ${BASE_MCP_PORT + 1} / plugin ${BASE_PLUGIN_PORT + 1}
                           figma-mcp 2    → MCP ${BASE_MCP_PORT + 2} / plugin ${BASE_PLUGIN_PORT + 2}

Options:
  --mcp-port <n>         Port MCP clients connect to (default: ${BASE_MCP_PORT} + id)
  --plugin-port <n>      Port the Figma plugin connects to (default: ${BASE_PLUGIN_PORT} + id)
  --host <addr>          Bind address for the MCP HTTP server (default: 0.0.0.0)
  --path <path>          MCP HTTP endpoint path (default: /mcp)
  --stdio                Also expose the MCP server over stdio (for local clients)
  -v, --version          Print version and exit
  -h, --help             Print this help and exit

Endpoints:
  http(s)://<host>:<mcp-port><path>   MCP Streamable HTTP (remote clients)
  http://<host>:<mcp-port>/health     Bridge status (plain JSON)
  ws://<host>:<plugin-port>           Figma plugin WebSocket bridge

Environment:
  FIGMA_MCP_ID            Same as the positional [id] argument
  FIGMA_MCP_HTTP_PORT     Same as --mcp-port
  FIGMA_MCP_PLUGIN_PORT   Same as --plugin-port
  FIGMA_MCP_PORT          Legacy alias of --plugin-port
  FIGMA_MCP_HOST          Same as --host
  FIGMA_MCP_PATH          Same as --path

MCP client config (remote):
  { "mcpServers": { "figma-mcp": { "url": "http://localhost:${BASE_MCP_PORT}/mcp" } } }
  { "mcpServers": { "figma-mcp-1": { "url": "http://localhost:${BASE_MCP_PORT + 1}/mcp" } } }
`);
  process.exit(0);
}

const options = parseArgs(argv);

function parseArgs(args) {
  const opts = {
    id: DEFAULT_ID,
    mcpPort: null,
    pluginPort: null,
    host: process.env.FIGMA_MCP_HOST || "0.0.0.0",
    path: process.env.FIGMA_MCP_PATH || "/mcp",
    stdio: args.includes("--stdio"),
  };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    switch (arg) {
      case "--mcp-port":
      case "--http-port":
        opts.mcpPort = Number(next());
        break;
      case "--plugin-port":
      case "--ws-port":
        opts.pluginPort = Number(next());
        break;
      case "--host":
        opts.host = next();
        break;
      case "--path":
        opts.path = next();
        break;
      case "--stdio":
      case "--version":
      case "-v":
      case "--help":
      case "-h":
        break;
      default:
        if (arg.startsWith("--mcp-port=")) opts.mcpPort = Number(arg.slice(11));
        else if (arg.startsWith("--http-port=")) opts.mcpPort = Number(arg.slice(12));
        else if (arg.startsWith("--plugin-port=")) opts.pluginPort = Number(arg.slice(14));
        else if (arg.startsWith("--ws-port=")) opts.pluginPort = Number(arg.slice(10));
        else if (arg.startsWith("--host=")) opts.host = arg.slice(7);
        else if (arg.startsWith("--path=")) opts.path = arg.slice(7);
        else positional.push(arg);
    }
  }

  const idFromArg = Number(positional[0]);
  const idFromEnv = Number(process.env.FIGMA_MCP_ID);
  if (Number.isInteger(idFromArg) && idFromArg >= 0) opts.id = idFromArg;
  else if (positional[0] !== undefined) {
    console.error(`[figma-mcp] invalid id "${positional[0]}" — expected a non-negative integer, using ${opts.id}`);
  } else if (Number.isInteger(idFromEnv) && idFromEnv >= 0) {
    opts.id = idFromEnv;
  }

  if (!opts.path.startsWith("/")) opts.path = `/${opts.path}`;

  // explicit port flags/env win; otherwise base + id
  opts.mcpPort = pickPort(opts.mcpPort, process.env.FIGMA_MCP_HTTP_PORT, BASE_MCP_PORT + opts.id);
  opts.pluginPort = pickPort(
    opts.pluginPort,
    process.env.FIGMA_MCP_PLUGIN_PORT ?? process.env.FIGMA_MCP_PORT, // legacy alias
    BASE_PLUGIN_PORT + opts.id,
  );
  return opts;
}

function pickPort(flagValue, envValue, fallback) {
  for (const v of [flagValue, envValue]) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return fallback;
}

const MCP_PORT = options.mcpPort;
const PLUGIN_PORT = options.pluginPort;
const MCP_PATH = options.path;
const HOST = options.host;

const bridge = new FigmaBridge({ port: PLUGIN_PORT, id: options.id });

const EXECUTE_SYSTEM_PROMPT = `
Figma JS runtime rules (the code you write runs inside the Figma plugin main thread, sandboxed):
- Available: "figma" (proxied API), "console" (captured & streamed back to you), "helpers".
- helpers.createText(chars, { fontSize, fontName, color }) → loads a font for you and returns a TextNode.
  NEVER do "figma.createText(); t.characters = ..." directly without await figma.loadFontAsync(...) first — it throws.
- Code is wrapped in an async function: you may use top-level "await" and top-level "return { ... }".
- Loops are instrumented with a cooperative timeout; a run exceeding limits is cancelled with code TIMEOUT.
- Blocked (validation error POLICY): fetch, XMLHttpRequest, WebSocket, eval, Function, require, import(),
  globalThis, prototype-chain access (.constructor/.prototype/__proto__), dynamic obj[expr], figma.ui/showUI/settings.
- Prefer returning a small JSON summary: return { created: [...ids], page: figma.currentPage.name };
`.trim();

const tools = [
  {
    name: "figma_status",
    description: "Check whether the Figma plugin is connected and which file is open. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "execute_code",
    description: `Execute arbitrary JavaScript against the live figma.* API inside the Figma plugin sandbox.
Returns { ok, value, createdNodes, logs } or { ok:false, code, error, logs } — read logs/error and fix your code, then retry.
${EXECUTE_SYSTEM_PROMPT}`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript source to execute (see rules in description)." },
        timeoutMs: { type: "number", description: "Max execution time enforced inside the plugin (default 5000, max 60000)." },
        maxNodes: { type: "number", description: "Max figma.create* calls allowed (default 1000)." },
        maxCommands: { type: "number", description: "Max guarded loop iterations/commands (default 10000)." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "get_document_info",
    description: "Read-only helper: current page, canvas children overview, file name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_selection",
    description: "Read-only helper: currently selected nodes (id, name, type, bounds).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_execution",
    description: "Cancel a running execute_code by its execution id (id is returned in result; useful when a run is stuck awaiting approval in the plugin UI).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/** A fresh MCP Server instance with all tool handlers wired (one per HTTP session). */
function createMcpServer() {
  const server = new Server(
    { name: "figma-mcp", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    try {
      switch (name) {
        case "figma_status":
          return jsonResult(bridge.status());

        case "execute_code": {
          if (typeof args.code !== "string" || !args.code.trim()) {
            return jsonResult({ ok: false, code: "SYNTAX", error: "Empty code." });
          }
          const result = await bridge.execute(args.code, {
            timeoutMs: args.timeoutMs,
            maxNodes: args.maxNodes,
            maxCommands: args.maxCommands,
          });
          return jsonResult(result);
        }

        case "get_document_info": {
          const code = `
            return {
              file: figma.root.name,
              currentPage: figma.currentPage.name,
              pages: figma.root.children.map(p => ({ id: p.id, name: p.name, childCount: p.children ? p.children.length : "lazy" })),
              topLevels: figma.currentPage.children.slice(0, 50).map(n => ({ id: n.id, name: n.name, type: n.type })),
              totalNodes: figma.currentPage.children.length,
            };`;
          const result = await bridge.execute(code, { timeoutMs: 5000 });
          return jsonResult(result);
        }

        case "get_selection": {
          const code = `
            return figma.currentPage.selection.map(n => ({
              id: n.id,
              name: n.name,
              type: n.type,
              x: "x" in n ? n.x : undefined,
              y: "y" in n ? n.y : undefined,
              width: "width" in n ? n.width : undefined,
              height: "height" in n ? n.height : undefined,
            }));`;
          const result = await bridge.execute(code, { timeoutMs: 5000 });
          return jsonResult(result);
        }

        case "cancel_execution":
          return jsonResult({ sent: bridge.cancel(String(args.id)) });

        default:
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
          };
      }
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Internal error: ${err?.message || err}` }],
      };
    }
  });

  return server;
}

// ---------- Remote MCP transport: Streamable HTTP ----------
/** sessionId -> { server, transport } */
const sessions = new Map();

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version, last-event-id, www-authenticate");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isInitializeRequest(body) {
  return Boolean(body && body.method === "initialize");
}

async function handleMcpRequest(req, res) {
  applyCors(res);
  const sessionId = req.headers["mcp-session-id"];

  if (req.method === "GET" || req.method === "DELETE") {
    const entry = sessionId && sessions.get(sessionId);
    if (!entry) {
      sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "No such session" }, id: null });
      return;
    }
    await entry.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${err.message}` }, id: null });
    return;
  }

  if (isInitializeRequest(body)) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // sessionId only exists after handleRequest() processes initialize → register here
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
        console.error(`[figma-mcp] MCP session opened (${id}) — active: ${sessions.size}`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        server.close().catch(() => {});
        console.error(`[figma-mcp] MCP session closed (${id}) — active: ${sessions.size}`);
      },
    });
    transport.onerror = (err) => console.error(`[figma-mcp] transport error: ${err?.message || err}`);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  if (!sessionId) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad request: missing Mcp-Session-Id header (initialize first)." },
      id: (body && body.id) ?? null,
    });
    return;
  }

  const entry = sessions.get(sessionId);
  if (!entry) {
    sendJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Not found: unknown or expired session." },
      id: (body && body.id) ?? null,
    });
    return;
  }
  await entry.transport.handleRequest(req, res, body);
}

const httpServer = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === MCP_PATH || url === `${MCP_PATH}/`) {
    handleMcpRequest(req, res).catch((err) => {
      console.error(`[figma-mcp] request failed: ${err?.message || err}`);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      else res.end();
    });
    return;
  }

  if (url === "/health" || url === "/status") {
    applyCors(res);
    sendJson(res, 200, { name: "figma-mcp", version: PKG_VERSION, ...bridge.status() });
    return;
  }

  applyCors(res);
  sendJson(res, 404, {
    error: `Not found. MCP endpoint: ${MCP_PATH} · health: /health · plugin bridge: ws://${HOST}:${PLUGIN_PORT}`,
  });
});

function startHttpServer() {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(MCP_PORT, HOST, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
}

// ---------- Boot ----------
try {
  await bridge.start();
  await startHttpServer();
} catch (err) {
  console.error(`[figma-mcp] failed to start: ${err?.message || err}`);
  process.exit(1);
}

if (options.stdio) {
  await server_connectStdio();
}

async function server_connectStdio() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`[figma-mcp] stdio transport enabled`);
}

console.error(
  `[figma-mcp] v${PKG_VERSION} ready — id ${options.id} · MCP (remote) http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${MCP_PORT}${MCP_PATH} · plugin bridge ws://localhost:${PLUGIN_PORT}`,
);

// ---------- Shutdown ----------
function shutdown(signal) {
  console.error(`[figma-mcp] ${signal} received, shutting down`);
  for (const [, entry] of sessions) {
    entry.transport.close();
    entry.server.close().catch(() => {});
  }
  sessions.clear();
  httpServer.close();
  bridge.stop();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
