[English](README.md) | [Tiếng Việt](README.vi.md)

# Figma MCP — "Claude Code for Figma"

MCP server + Figma plugin: the AI agent writes **JavaScript**, the code is **AST-validated** and then run in a **sandbox with timeout/budget** directly on the plugin main thread with `figma.*`.

```text
AI Agent ──MCP (Streamable HTTP :10030+id)──► MCP Server ──ws://localhost:10060+id──► Plugin UI (bridge + approval)
                                                                    │ postMessage
                                                                    ▼
                                                        Plugin Main Thread
                                                        AST validator → sandbox executor → figma.*
```

## Structure

| Path | Role |
|---|---|
| `server/` | MCP server (remote: Streamable HTTP on port 10030+id, plus opt-in `--stdio`) + WebSocket bridge for the plugin (port 10060+id) |
| `plugin/` | Figma plugin — `src/validator.ts` (AST denylist + loop instrumentation), `src/executor.ts` (guard, console capture, figma Proxy, font helpers), `ui.html` (WS + approval UX) |
| `plugin/scripts/harden.mjs` | Post-build: escapes `import(` / `import.meta` inside acorn string literals — the Figma sandbox scans text and rejects the bundle if it finds dynamic patterns ("possible import expression rejected") |

## Installation

```bash
npm install                 # workspaces: server + plugin
npm run build:plugin        # esbuild → plugin/code.js (+ harden)
```

### Install the MCP server as a global CLI (recommended)

```bash
npm run install:global      # = npm install -g ./server
# or dev mode, auto-updates when you edit the code:
npm run link                # = npm link --workspace server

figma-mcp --version         # verify the command is on your PATH
```

### 1. Run the MCP server

```bash
figma-mcp            # id 0 → MCP 10030, plugin 10060
figma-mcp 1          # id 1 → MCP 10031, plugin 10061
figma-mcp 2          # id 2 → MCP 10032, plugin 10062
npm run start:server # run directly from the repo (id 0)
```

The command-line argument is an **id (number, default 0)** — both ports are offset by the id, so you can run **multiple servers in parallel** (one server per Figma plugin).

| Flag / Env | Meaning |
|---|---|
| `[id]` | Port offset: MCP = 10030+id, plugin = 10060+id |
| `--mcp-port <n>` | Override the MCP client port (env `FIGMA_MCP_HTTP_PORT`) |
| `--plugin-port <n>` | Override the plugin bridge port (env `FIGMA_MCP_PLUGIN_PORT`, or legacy `FIGMA_MCP_PORT`) |
| `--host <addr>` | HTTP bind address (default `0.0.0.0` — open to remote clients on other machines; use `127.0.0.1` if localhost is enough) |
| `--path <p>` | MCP HTTP endpoint (default `/mcp`) |
| `--stdio` | Additionally expose MCP over stdio (legacy local clients such as Claude Desktop) |

The server listens on:
- **http://<host>:10030+id/mcp** — MCP Streamable HTTP for remote clients (+ `GET /health` to check bridge status)
- **ws://localhost:10060+id** — for the Figma plugin to connect to

> ⚠️ **Note when running remotely**: an MCP client on any machine can connect (the server binds `0.0.0.0`), but
> the Figma plugin still only connects to `ws://localhost:…` → the plugin **must run on the same machine as the server**.
> If Figma is on another machine: run the server on the machine that has Figma, then open a tunnel from the client machine
> (`ssh -L 10030:localhost:10030 user@figma-machine`) and point `url` at `http://localhost:10030/mcp`.

### 2. Register the plugin in Figma (one time)

1. Open Figma (web or desktop app) → create any file.
2. `Plugins → Development → Import plugin from manifest…`
3. Select the file `figma-mcp/plugin/manifest.json`.
4. Run the plugin: `Plugins → Development → Figma MCP Connector`.
5. The plugin UI shows a green dot **"Connected"** once it reaches the MCP server.

### 3. Configure the MCP client (remote — Claude Desktop / Cline / Cursor / other MCP clients)

Because the server runs remotely (HTTP), the client only needs a `url` — no `command` required:

```json
{
  "mcpServers": {
    "figma-mcp":   { "url": "http://localhost:10030/mcp" },
    "figma-mcp-1": { "url": "http://localhost:10031/mcp" },
    "figma-mcp-2": { "url": "http://localhost:10032/mcp" }
  }
}
```

> Connecting to another machine: replace `localhost` with the IP/host of the machine running the server (the server already binds `0.0.0.0`).
> Client that only supports stdio? add `--stdio` to the server command, e.g. `"command": "figma-mcp", "args": ["--stdio"]`.

## Usage

Tools exposed to the agent:

| Tool | Description |
|---|---|
| `figma_status` | Whether the plugin is connected and which file is open |
| `execute_code` | Run JavaScript against `figma.*` (with limits) |
| `get_document_info` | Quick read of pages/currentPage/topLevels |
| `get_selection` | Currently selected nodes |
| `cancel_execution` | Cancel a run that is awaiting approval / currently executing |

Example prompt for the agent: *"Create 3 product cards on the current page using execute_code"*.

Self-fixing flow (the killer feature of the system):

```text
Generate → Execute → Error/POLICY/logs → Agent reads logs + createdNodes → Fix → Execute again → ✔
```

### Rules when the agent writes code (already embedded in the tool description)

- Available: `figma` (proxied), `console` (streamed back to the agent), `helpers`.
- **Use `await helpers.createText("Hello", { fontSize: 24 })`** — do not set `.characters` directly (Figma requires loading the font first).
- Top-level `await` / `return {...}` are allowed.
- Blocked (`POLICY` error): `fetch`, `eval`, `Function`, `import()`, `.constructor`/`.prototype`/`__proto__`, dynamic `obj[expr]`, `figma.ui`/`showUI`/`settings`.
- Every loop is instrumented with `await __guard.tick()` → timeout, cancel, and budget guards.

### Approval UX

By default **Auto-run is OFF**: each `execute` command shows the code plus **Run/Reject** buttons in the plugin UI. Enable Auto-run once you trust the workflow.

### Plugin UI

- Status dot: red (disconnected) / green (connected to the MCP server).
- **MCP server port** field + **Apply** button (default `10060`): sets the bridge port, persists it via `figma.clientStorage`, and reconnects immediately. Running `figma-mcp 1` → enter `10061`.
- **↻ Reconnect** button: closes the current socket (including half-dead states) and re-handshakes from scratch — useful when the MCP server restarts and the plugin does not notice.
- **Auto-run** toggle (default ON).
- Feed showing pending code for review, streaming logs, and per-run results.
- Auto-reconnect every 2.5s + `ping` heartbeat every 3s; fallback `ws://localhost` → `ws://127.0.0.1`.

## Known limitations (MVP)

- One **active** plugin connection at a time **per server instance** — a new connection **replaces** the old one (last-man-wins; the old socket is closed with close code `4001`, the UI reports "Replaced", and it does not auto-reconnect). To plug in multiple plugins in parallel → run multiple servers with different ids (`figma-mcp 1`, `figma-mcp 2`, …).
- ⚠️ **Security**: HTTP binds `0.0.0.0` by default with **no auth** — any machine on the LAN/network that can reach port 10030+id can execute code in your Figma. On untrusted networks: run behind a firewall/VPN, or use `--host 127.0.0.1` and tunnel (ssh -L). The plugin WS bridge is also open on `0.0.0.0`.
- The Proxy only counts top-level `figma.create*`; `node.clone()` is not counted (still bounded by the overall timeout).
- Infinite synchronous recursion cannot be interrupted by ticks (only new loops are instrumented) — the server watchdog returns `DISCONNECTED`, and the plugin needs a reload.
- `ws://localhost` from an https page works in most browsers; if blocked, use the Figma desktop app (see architecture.md § Mixed content).

## Quick validator/executor tests (no Figma required)

```bash
node plugin/tests/run-tests.mjs        # 27 unit tests: denylist, loop instrumentation, timeout/cancel/budget
node scripts/integration-test.mjs      # 10 integration tests: spawn `figma-mcp <id>` + mock plugin WS + remote MCP client (HTTP)
```
