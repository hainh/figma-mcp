# Figma MCP — "Claude Code for Figma"

MCP server + Figma plugin: AI agent viết **JavaScript**, code được **AST-validate** rồi chạy trong **sandbox có timeout/budget** ngay trên plugin main thread với `figma.*`.

```text
AI Agent ──MCP(stdio)──► MCP Server ──ws://localhost:3055──► Plugin UI (bridge + approval)
                                                                    │ postMessage
                                                                    ▼
                                                        Plugin Main Thread
                                                        AST validator → sandbox executor → figma.*
```

## Cấu trúc

| Path | Vai trò |
|---|---|
| `server/` | MCP server (stdio) + WebSocket bridge (cổng 3055) |
| `plugin/` | Figma plugin — `src/validator.ts` (AST denylist + loop instrumentation), `src/executor.ts` (guard, console capture, figma Proxy, font helpers), `ui.html` (WS + approval UX) |
| `plugin/scripts/harden.mjs` | Post-build: escape `import(` / `import.meta` trong string literal của acorn — Figma sandbox quét text và reject bundle nếu thấy pattern động ("possible import expression rejected") |

## Cài đặt

```bash
npm install                 # workspaces: server + plugin
npm run build:plugin        # esbuild → plugin/code.js (+ harden)
```

### 1. Chạy MCP server

```bash
npm run start:server
# hoặc FIGMA_MCP_PORT=3056 node server/src/index.js
```

Server lắng nghe:
- **stdio** — MCP protocol cho AI client
- **ws://localhost:3055** — cho Figma plugin kết nối vào

### 2. Đăng ký plugin trong Figma (một lần)

1. Mở Figma (web hoặc desktop app) → tạo file bất kỳ.
2. `Plugins → Development → Import plugin from manifest…`
3. Chọn file `figma-mcp/plugin/manifest.json`.
4. Chạy plugin: `Plugins → Development → Figma MCP Connector`.
5. UI plugin báo chấm xanh **"Connected"** khi bắt được MCP server.

### 3. Cấu hình MCP client (Claude Desktop / các MCP client khác)

```json
{
  "mcpServers": {
    "figma-mcp": {
      "command": "node",
      "args": ["C:/MyData/CreatorHub/figma-mcp/server/src/index.js"]
    }
  }
}
```

## Sử dụng

Tools expose cho agent:

| Tool | Mô tả |
|---|---|
| `figma_status` | Plugin đã connect chưa, đang mở file nào |
| `execute_code` | Chạy JavaScript trên `figma.*` (kèm limits) |
| `get_document_info` | Đọc nhanh pages/currentPage/topLevels |
| `get_selection` | Nodes đang selected |
| `cancel_execution` | Hủy run đang chờ approval / đang chạy |

Ví dụ prompt cho agent: *"Create 3 product cards on the current page using execute_code"*.

Flow tự sửa lỗi (điểm ăn tiền của hệ thống):

```text
Generate → Execute → Error/POLICY/logs → Agent đọc logs + createdNodes → Fix → Execute lại → ✔
```

### Rules khi agent viết code (đã ghi trong tool description)

- Có sẵn: `figma` (proxied), `console` (stream về agent), `helpers`.
- **Dùng `await helpers.createText("Hello", { fontSize: 24 })`** — không set `.characters` trực tiếp (Figma bắt buộc load font trước).
- Được dùng top-level `await` / `return {...}`.
- Bị chặn (lỗi `POLICY`): `fetch`, `eval`, `Function`, `import()`, `.constructor`/`.prototype`/`__proto__`, `obj[expr]` động, `figma.ui`/`showUI`/`settings`.
- Mọi loop được instrument `await __guard.tick()` → timeout, cancel, budget guard.

### Approval UX

Mặc định **Auto-run OFF**: mỗi lệnh `execute` hiện code + nút **Run/Reject** trong plugin UI. Bật Auto-run khi đã tin cậy workflow.

### Plugin UI

- Chấm trạng thái: đỏ (ngắt) / xanh (đã nối MCP server).
- Nút **↻ Reconnect**: đóng socket hiện tại (kể cả trạng thái nửa sống nửa chết) và bắt tay lại từ đầu — hữu ích khi restart MCP server mà plugin không tự nhận ra.
- Toggle **Auto-run** (mặc định OFF).
- Feed hiển thị code chờ duyệt, log streaming, kết quả từng run.
- Tự reconnect mỗi 2.5s + heartbeat `ping` 3s; fallback `ws://localhost` → `ws://127.0.0.1`.

## Limitations đã biết (MVP)

- 1 plugin connection tại một thời điểm (connection thứ 2 nhận `BUSY`).
- Proxy chỉ đếm `figma.create*` top-level; `node.clone()` không đếm (vẫn bị giới hạn timeout tổng).
- Sync recursion vô hạn không cắt được bằng tick (loop mới được instrument) — server watchdog trả `DISCONNECTED`, cần reload plugin.
- `ws://localhost` từ trang https hoạt động ở đa số browser; nếu bị chặn, dùng Figma desktop app (xem architecture.md § Mixed content).

## Test nhanh validator/executor (không cần Figma)

```bash
node plugin/tests/run-tests.mjs        # 27 unit tests: denylist, loop instrumentation, timeout/cancel/budget
node scripts/integration-test.mjs      # 6 integration tests: spawn server + mock plugin WS + MCP stdio client
```
