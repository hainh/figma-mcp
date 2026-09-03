# figma-mcp

MCP server that bridges AI agents (Claude Desktop, Claude Code, Cursor, …) to a live
Figma file through the [Figma MCP Connector plugin](../plugin).

- **stdio** — MCP protocol (`figma_status`, `execute_code`, `get_document_info`, `get_selection`, `cancel_execution`)
- **ws://localhost:3055** — WebSocket bridge the Figma plugin connects to

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
# [figma-mcp] WebSocket bridge listening on ws://localhost:3055
# [figma-mcp] MCP server ready on stdio (tools: figma_status, execute_code, ...)
```

Press Ctrl+C to stop. The plugin connects to it when you run
"Plugins → Development → Figma MCP Connector" inside Figma.

## Configure an MCP client

Because the CLI is on your `PATH`, config is just:

```json
{
  "mcpServers": {
    "figma-mcp": {
      "command": "figma-mcp"
    }
  }
}
```

On Windows, if a client refuses a bare command, use the wrapper:

```json
{
  "mcpServers": {
    "figma-mcp": {
      "command": "cmd",
      "args": ["/c", "figma-mcp"]
    }
  }
}
```

If you use several clients at once, they share one `figma-mcp` process only when
the client spawns it — each spawned process binds the WebSocket port, so run
**one** server per plugin. Change the port with the `FIGMA_MCP_PORT` env var:

```json
{
  "mcpServers": {
    "figma-mcp": {
      "command": "figma-mcp",
      "env": { "FIGMA_MCP_PORT": "3056" }
    }
  }
}
```

## Requirements

- Node.js >= 18
- Figma desktop app (or browser) with the MCP Connector plugin imported
