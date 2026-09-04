[English](README.md) | [Tiếng Việt](README.vi.md)

# Figma MCP — "Claude Code for Figma"

MCP server + Figma plugin: AI agent viết **JavaScript**, code được **AST-validate** rồi chạy trong **sandbox có timeout/budget** ngay trên plugin main thread với `figma.*`.

```text
AI Agent ──MCP (Streamable HTTP :10030+id)──► MCP Server ──ws://localhost:10060+id──► Plugin UI (bridge + approval)
                                                                    │ postMessage
                                                                    ▼
                                                        Plugin Main Thread
                                                        AST validator → sandbox executor → figma.*
```

## Cấu trúc

| Path | Vai trò |
|---|---|
| `server/` | MCP server (remote: Streamable HTTP cổng 10030+id, kèm `--stdio` opt-in) + WebSocket bridge cho plugin (cổng 10060+id) |
| `plugin/` | Figma plugin — `src/validator.ts` (AST denylist + loop instrumentation), `src/executor.ts` (guard, console capture, figma Proxy, font helpers), `ui.html` (WS + approval UX) |
| `plugin/scripts/harden.mjs` | Post-build: escape `import(` / `import.meta` trong string literal của acorn — Figma sandbox quét text và reject bundle nếu thấy pattern động ("possible import expression rejected") |

## Cài đặt

```bash
npm install                 # workspaces: server + plugin
npm run build:plugin        # esbuild → plugin/code.js (+ harden)
```

### Cài MCP server thành CLI toàn cục (khuyến nghị)

```bash
npm run install:global      # = npm install -g ./server
# hoặc dev mode, tự cập nhật khi sửa code:
npm run link                # = npm link --workspace server

figma-mcp --version         # kiểm tra lệnh đã có trên PATH
```

### 1. Chạy MCP server

```bash
figma-mcp            # id 0 → MCP 10030, plugin 10060
figma-mcp 1          # id 1 → MCP 10031, plugin 10061
figma-mcp 2          # id 2 → MCP 10032, plugin 10062
npm run start:server # chạy trực tiếp từ repo (id 0)
```

Tham số dòng lệnh là **id (number, mặc định 0)** — cả hai cổng đều cộng thêm id, nên chạy **nhiều server song song** được (mỗi server một plugin Figma).

| Cờ / Env | Ý nghĩa |
|---|---|
| `[id]` | Bù cổng: MCP = 10030+id, plugin = 10060+id |
| `--mcp-port <n>` | Ghi đè cổng MCP client (env `FIGMA_MCP_HTTP_PORT`) |
| `--plugin-port <n>` | Ghi đè cổng plugin bridge (env `FIGMA_MCP_PLUGIN_PORT`, hoặc `FIGMA_MCP_PORT` cũ) |
| `--host <addr>` | Bind address cho HTTP (mặc định `0.0.0.0` — mở cho client remote khác máy; dùng `127.0.0.1` nếu chỉ cần localhost) |
| `--path <p>` | Endpoint MCP HTTP (mặc định `/mcp`) |
| `--stdio` | Mở thêm MCP qua stdio (client local kiểu Claude Desktop cũ) |

Server lắng nghe:
- **http://<host>:10030+id/mcp** — MCP Streamable HTTP cho client remote (+ `GET /health` xem trạng thái bridge)
- **ws://localhost:10060+id** — cho Figma plugin kết nối vào

> ⚠️ **Lưu ý khi chạy remote**: MCP client ở máy nào cũng connect được (server bind `0.0.0.0`), nhưng
> Figma plugin vẫn chỉ nối `ws://localhost:…` → plugin **phải chạy trên cùng máy với server**.
> Trường hợp Figma ở máy khác: chạy server ngay máy có Figma, rồi mở tunnel từ máy client
> (`ssh -L 10030:localhost:10030 user@may-figma`) và trỏ `url` về `http://localhost:10030/mcp`.

### 2. Đăng ký plugin trong Figma (một lần)

1. Mở Figma (web hoặc desktop app) → tạo file bất kỳ.
2. `Plugins → Development → Import plugin from manifest…`
3. Chọn file `figma-mcp/plugin/manifest.json`.
4. Chạy plugin: `Plugins → Development → Figma MCP Connector`.
5. UI plugin báo chấm xanh **"Connected"** khi bắt được MCP server.

### 3. Cấu hình MCP client (remote — Claude Desktop / Cline / Cursor / các MCP client khác)

Vì server chạy remote (HTTP), client chỉ cần khai báo `url` — không cần `command`:

```json
{
  "mcpServers": {
    "figma-mcp":   { "url": "http://localhost:10030/mcp" },
    "figma-mcp-1": { "url": "http://localhost:10031/mcp" },
    "figma-mcp-2": { "url": "http://localhost:10032/mcp" }
  }
}
```

> Kết nối sang máy khác: thay `localhost` bằng IP/host của máy chạy server (server bind `0.0.0.0` sẵn).
> Client chỉ hỗ trợ stdio? thêm `--stdio` vào lệnh chạy server, ví dụ `"command": "figma-mcp", "args": ["--stdio"]`.

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
- Ô **MCP server port** + nút **Apply** (mặc định `10060`): đặt cổng bridge, lưu qua `figma.clientStorage` và reconnect ngay. Chạy `figma-mcp 1` → nhập `10061`.
- Nút **↻ Reconnect**: đóng socket hiện tại (kể cả trạng thái nửa sống nửa chết) và bắt tay lại từ đầu — hữu ích khi restart MCP server mà plugin không tự nhận ra.
- Toggle **Auto-run** (mặc định ON).
- Feed hiển thị code chờ duyệt, log streaming, kết quả từng run.
- Tự reconnect mỗi 2.5s + heartbeat `ping` 3s; fallback `ws://localhost` → `ws://127.0.0.1`.

## Limitations đã biết (MVP)

- 1 plugin connection **active** tại một thời điểm **cho mỗi server instance** — kết nối mới sẽ **thay thế** (replace) kết nối cũ theo cơ chế last-man-wins (socket cũ đóng bằng close code `4001`, UI báo "Replaced", không tự reconnect). Muốn cắm nhiều plugin song song → chạy nhiều server với id khác nhau (`figma-mcp 1`, `figma-mcp 2`, …).
- ⚠️ **Bảo mật**: mặc định HTTP bind `0.0.0.0` và **không có auth** — bất kỳ máy nào trong LAN/mạng gọi được cổng 10030+id đều có thể execute code trong Figma của bạn. Ở mạng không tin cậy: chạy sau firewall/VPN, hoặc `--host 127.0.0.1` rồi tunnel (ssh -L). Bridge WS của plugin cũng đang mở `0.0.0.0`.
- Proxy chỉ đếm `figma.create*` top-level; `node.clone()` không đếm (vẫn bị giới hạn timeout tổng).
- Sync recursion vô hạn không cắt được bằng tick (loop mới được instrument) — server watchdog trả `DISCONNECTED`, cần reload plugin.
- `ws://localhost` từ trang https hoạt động ở đa số browser; nếu bị chặn, dùng Figma desktop app (xem architecture.md § Mixed content).

## Test nhanh validator/executor (không cần Figma)

```bash
node plugin/tests/run-tests.mjs        # 27 unit tests: denylist, loop instrumentation, timeout/cancel/budget
node scripts/integration-test.mjs      # 10 integration tests: spawn `figma-mcp <id>` + mock plugin WS + remote MCP client (HTTP)
```
