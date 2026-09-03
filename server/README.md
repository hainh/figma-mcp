# figma-mcp

MCP server that bridges AI agents (Claude Desktop, Claude Code, Cursor, …) to a live
Figma file through the [Figma MCP Connector plugin](../plugin).

- **http://<host>:10030+id/mcp** — MCP Streamable HTTP for **remote** MCP clients (+ `GET /health`)
- **ws://localhost:10060+id** — WebSocket bridge the Figma plugin connects to
- `--stdio` — optional stdio transport for clients that cannot speak HTTP

The `id` is a plain number given on the command line; it offsets both ports so several
servers can run at the same time (one per Figma file/plugin).

AI agents write JavaScript against `figma.*`; the code is AST-validated and executed
in a sandboxed plugin runtime with timeout/node/command budgets.

## Install

```bash
# From a clone of this repo (works offline, no registry needed)
npm install -g ./server

# Or link it for development (edits to source apply immediately)
cd server && npm link
```

Then verify:

```bash
figma-mcp
# [figma-mcp] WebSocket bridge listening on ws://localhost:10060
# [figma-mcp] v0.1.0 ready — id 0 · MCP (remote) http://localhost:10030/mcp · plugin bridge ws://localhost:10060
```

Press Ctrl+C to stop. The plugin connects to it when you run
"Plugins → Development → Figma MCP Connector" inside Figma (its port field defaults to `10060`).

## Configure an MCP client (remote)

The server speaks MCP over HTTP, so clients just need a URL — no command, no spawn:

```json
{
  "mcpServers": {
    "figma-mcp":   { "url": "http://localhost:10030/mcp" },
    "figma-mcp-1": { "url": "http://localhost:10031/mcp" },
    "figma-mcp-2": { "url": "http://localhost:10032/mcp" }
  }
}
```

To reach a server on **another machine**, start it with a reachable bind address
(`figma-mcp` already binds `0.0.0.0` by default) and use its host/IP:

```json
{ "mcpServers": { "figma-mcp": { "url": "http://192.168.1.20:10030/mcp" } } }
```

Clients that only support stdio can spawn the server with `--stdio` (it then serves MCP on
stdio while still exposing the plugin bridge on `10060 + id`):

```json
{
  "mcpServers": {
    "figma-mcp": { "command": "figma-mcp", "args": ["--stdio"] }
  }
}
```

On Windows, if a client refuses a bare command, use the wrapper:

```json
{
  "mcpServers": {
    "figma-mcp": { "command": "cmd", "args": ["/c", "figma-mcp", "--stdio"] }
  }
}
```

## Running several servers at once

Each instance owns one plugin connection, so use one server per Figma file:

```bash
figma-mcp 1 &   # MCP http://localhost:10031/mcp · plugin ws://localhost:10061
figma-mcp 2 &   # MCP http://localhost:10032/mcp · plugin ws://localhost:10062
```

Then set the matching port in each Figma plugin UI (port field → `10061`, `10062`, …).
Ports can also be pinned explicitly, which wins over the id offset:

```bash
figma-mcp --mcp-port 12000 --plugin-port 12001
FIGMA_MCP_ID=3 figma-mcp                     # → 10033 / 10063
FIGMA_MCP_PLUGIN_PORT=13001 figma-mcp 3      # → 10033 / 13001
```

## Options

| Flag / env | Default | Meaning |
|---|---|---|
| `[id]` (positional) | `0` | Non-negative integer added to both base ports |
| `--mcp-port` / `FIGMA_MCP_HTTP_PORT` | `10030 + id` | Port MCP clients connect to |
| `--plugin-port` / `FIGMA_MCP_PLUGIN_PORT` (`FIGMA_MCP_PORT` legacy) | `10060 + id` | Port the Figma plugin connects to |
| `--host` / `FIGMA_MCP_HOST` | `0.0.0.0` | HTTP bind address (`127.0.0.1` for localhost only) |
| `--path` / `FIGMA_MCP_PATH` | `/mcp` | MCP HTTP endpoint path |
| `--stdio` | off | Also serve MCP over stdio |

Tools exposed: `figma_status`, `execute_code`, `get_document_info`, `get_selection`, `cancel_execution`.

## Security note

The HTTP endpoint has **no authentication**. Bound to `0.0.0.0`, anything that can reach the
port can run JavaScript in your open Figma file. On untrusted networks keep it behind a
firewall/VPN, or bind locally and tunnel: `figma-mcp --host 127.0.0.1` + `ssh -L 10030:localhost:10030 host`.

## Requirements

- Node.js >= 18
- Figma desktop app (or browser) with the MCP Connector plugin imported
