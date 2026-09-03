# Figma MCP Connector — Plugin

Figma plugin runtime cho MCP: thực thi code JavaScript do AI sinh ra, chạy trong
sandbox có kiểm duyệt AST (`figma.*`).

## Kiến trúc build

```
code.ts (entry) ─┐
src/main.ts     ─┤→ esbuild --bundle (IIFE) → code.js → scripts/harden.mjs → Figma
src/executor.ts ─┤        (npm run build)          (escape pattern import( / import.meta
src/validator.ts ┘                                    để vượt static check của sandbox)
```

- `src/validator.ts` — security boundary: AST denylist + instrument mọi loop với
  `await __guard.tick()` (timeout / cancel / command budget).
- `src/executor.ts` — sandbox runtime: Proxy bọc `figma.*`, console capture, helpers.
- `src/main.ts` — message router giữa UI (websocket bridge) và executor, approval flow.
- `ui.html` — UI phía browser: WS client tới MCP server + UX approve/reject.
- `code.js` — file build artifact (đã gitignore). `manifest.json` trỏ `main: "code.js"`.

## Scripts

```bash
npm run build      # esbuild bundle code.ts → code.js (+ code.js.map) + harden
npm run watch      # esbuild watch + harden tự động sau mỗi rebuild
npm run typecheck  # tsc --noEmit (kiểm tra type, không phát sinh file)
npm run lint       # eslint (typescript-eslint + @figma/eslint-plugin-figma-plugins)
npm test           # smoke tests validator + executor (Node native TS type-stripping, cần Node >= 22.18)
npm run map-stack  # map stack trace "code.js:line:col" từ Figma console về src/*.ts
```

## Debugging trên Figma (source maps)

- Bundle **không minify** (esbuild mặc định) → `code.js` vẫn đọc được, mỗi hàm có
  comment `// src/xxx.ts` phía trên, tên hàm trong stack giữ nguyên.
- Build sinh `code.js.map` (external, gitignore — Figma không upload file này khi
  publish, sandbox QuickJS cũng không tự decode map).
- Khi error trên main thread in stack dạng `at fn (code.js:6168:3)`, map về TS:
  ```bash
  node scripts/map-stack.mjs "at onExecuteRequest (code.js:6168:3)"
  # → src/main.ts:61:1
  ```
  hoặc `pbpaste | node scripts/map-stack.mjs`.
- Lưu ý: `harden.mjs` chạy SAU khi sinh map, escape `import(` → `import\u0028`
  chỉ trong string literal nội bộ acorn → column trên vài dòng đó lệch +5 ký tự;
  code trong `src/*.ts` không bị ảnh hưởng.
- UI (`ui.html`) chạy trong iframe → debug bình thường bằng Chrome DevTools
  (chuột phải → Inspect).

## Nạp plugin vào Figma

1. `npm run build` (hoặc `npm run watch` trong lúc dev).
2. Figma → Plugins → Development → Import plugin from manifest → chọn `plugin/manifest.json`.
3. Chạy MCP server (`npm run start:server` ở thư mục cha, hoặc `figma-mcp <id>`) rồi mở plugin;
   UI connect tới `ws://localhost:10060+id` — đặt cổng trong ô **MCP server port** (mặc định `10060`,
   lưu qua `figma.clientStorage`). Ví dụ `figma-mcp 1` → nhập `10061`.

## Ghi chú

- Thêm file mới trong `src/` → import bằng phần mở rộng `.ts` (ví dụ
  `import { x } from "./foo.ts"`). esbuild resolve trực tiếp; Node tests cũng vậy.
- KHÔNG được dùng dynamic `import()` / `import.meta` trong source — Figma sandbox
  từ chối; `harden.mjs` sẽ fail build nếu phát hiện pattern sống.
- `ui.html` được khai báo trong `manifest.json` (`"ui": "ui.html"`); main thread gọi
  `figma.showUI(__html__)`.
- `manifest.json → networkAccess.allowedDomains` là `*` nên mọi cổng localhost đều được phép.
  Nếu siết lại thành danh sách cụ thể thì phải liệt kê đủ dải sẽ dùng, ví dụ
  `ws://localhost:10060`…`ws://localhost:10069` (mỗi server `figma-mcp <id>` chiếm một cổng).
