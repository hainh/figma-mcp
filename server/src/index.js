#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

// ---------- CLI: --help / --version ----------
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(PKG_VERSION);
  process.exit(0);
}
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`figma-mcp — MCP server bridging AI agents to the Figma plugin runtime.

Usage: figma-mcp

Runs an MCP server on stdio and a WebSocket bridge for the Figma plugin.

Environment:
  FIGMA_MCP_PORT   WebSocket port the Figma plugin connects to (default: 3055)

Options:
  -v, --version    Print version and exit
  -h, --help       Print this help and exit

MCP client config:
  { "mcpServers": { "figma-mcp": { "command": "figma-mcp" } } }
`);
  process.exit(0);
}

const PORT = Number(process.env.FIGMA_MCP_PORT || 3055);
const bridge = new FigmaBridge({ port: PORT });

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

const server = new Server(
  { name: "figma-mcp", version: PKG_VERSION },
  { capabilities: { tools: {} } }
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

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

try {
  await bridge.start();
} catch (err) {
  console.error(`[figma-mcp] failed to start: ${err?.message || err}`);
  process.exit(1);
}
await server.connect(new StdioServerTransport());
console.error(`[figma-mcp] v${PKG_VERSION} ready — MCP on stdio, plugin bridge on ws://localhost:${PORT}`);
