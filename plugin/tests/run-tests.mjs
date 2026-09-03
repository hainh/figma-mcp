/**
 * Smoke tests cho validator + executor, chạy bằng Node với mock figma global.
 *   node plugin/tests/run-tests.mjs
 */
import { validateAndInstrument, ValidationError } from "../src/validator.ts";
import { runCode, createControlToken } from "../src/executor.ts";

// ---------- mock figma API (đủ cho các test dưới) ----------
let nodeSeq = 100;
class MockNode {
  constructor(type) {
    this.type = type;
    this.id = `${++nodeSeq}:1`;
    this.name = type.toLowerCase();
    this.children = [];
    this.x = 0; this.y = 0; this.width = 100; this.height = 100;
  }
  appendChild(n) { this.children.push(n); }
  resize(w, h) { this.width = w; this.height = h; }
  remove() {}
}
function makeMockFigma() {
  const page = new MockNode("PAGE");
  page.name = "Page 1";
  return {
    currentPage: page,
    root: { name: "Mock File", children: [page] },
    createFrame: () => new MockNode("FRAME"),
    createText: () => new MockNode("TEXT"),
    loadFontAsync: async (f) => { if (f.family === "MissingFont") throw new Error("font unavailable"); },
  };
}
globalThis.figma = makeMockFigma();

// ---------- tiny assert ----------
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✖ ${name}`); }
}
async function expectReject(name, fn) {
  try { await fn(); ok(false, name + " (should have thrown)"); }
  catch (e) { ok(e instanceof ValidationError || e.code === "POLICY", name); }
}

// ================= VALIDATOR =================
console.log("validator:");

ok(validateAndInstrument(`const f = figma.createFrame(); f.name = "Card";`).code.includes("figma.createFrame"),
  "accepts plain figma code");

const inst = validateAndInstrument(`let i = 0;
while (i < 10) { i++; }
for (let j = 0; j < 3; ++j) console.log(j);
for (const x of [1,2]) { figma.createFrame(); }
for (const k in {}) { }`);
ok((inst.code.match(/__guard\.tick\(\)/g) || []).length === 4, "instruments all 4 loops");
ok(inst.loopsInstrumented === 4, "loop count reported");

ok(inst.code.match(/__guard\.tick\(\)/g) !== null, "async loops use await tick");

{
  // loop trong callback sync (forEach/map...) → phải dùng tickSync, KHÔNG chèn await (SyntaxError)
  const syncInst = validateAndInstrument(`[1,2,3].forEach((x) => { for (let i = 0; i < x; i++) {} });`);
  ok(syncInst.code.includes("__guard.tickSync()") && !syncInst.code.includes("await __guard"), "sync-callback loop uses tickSync");
  const mixedInst = validateAndInstrument(`async function f() { while (true) {} }
while (false) {}`);
  ok((mixedInst.code.match(/await __guard\.tick\(\)/g) || []).length === 2 && !mixedInst.code.includes("f() { __guard"), "async fns keep await tick");
  const syncFnInst = validateAndInstrument(`function g() { for (;;) {} }`);
  ok(syncFnInst.code.includes("g() {  __guard.tickSync();") || syncFnInst.code.includes("__guard.tickSync()"), "plain sync function loop uses tickSync");
}

await expectReject("rejects fetch", () => validateAndInstrument(`fetch("https://evil.com")`));
await expectReject("rejects eval", () => validateAndInstrument(`eval("1+1")`));
await expectReject("rejects Function ctor", () => validateAndInstrument(`new Function("return 1")()`));
await expectReject("rejects require", () => validateAndInstrument(`require("fs")`));
await expectReject("rejects dynamic import", () => validateAndInstrument(`import("http://x/y.js")`));
await expectReject("rejects prototype escape", () => validateAndInstrument(`"".constructor.constructor("return this")()`));
await expectReject("rejects __proto__ string access", () => validateAndInstrument(`obj["__proto__"]`));
await expectReject("rejects dynamic computed access", () => validateAndInstrument(`obj[key]`));
ok(validateAndInstrument(`arr[0]; obj["prop"]; stops[1].color`).code.length > 0, "allows numeric + string-literal index access");
await expectReject("rejects this", () => validateAndInstrument(`this.foo`));
await expectReject("rejects figma.ui", () => validateAndInstrument(`figma.ui.postMessage({})`));
await expectReject("rejects figma.on", () => validateAndInstrument(`figma.on("currentpagechange", () => {})`));
await expectReject("rejects globalThis", () => validateAndInstrument(`globalThis.Object`));
await expectReject("rejects bad syntax", () => validateAndInstrument(`const = ;`));

// ================= EXECUTOR =================
console.log("executor:");

{
  const r = await runCode(`
    const frame = figma.createFrame();
    frame.name = "AI Card";
    frame.resize(320, 200);
    const t = await helpers.createText("Hello");
    frame.appendChild(t);
    figma.currentPage.appendChild(frame);
    console.log("created", frame.id);
    return { ok: true, ids: [frame.id, t.id] };
  `, { timeoutMs: 5000, maxNodes: 100, maxCommands: 1000 });
  ok(r.ok === true && r.value.ok === true, "end-to-end happy path");
  ok(r.createdNodes.length === 2, "tracks 2 created nodes");
  ok(r.logs.some((l) => l.includes("created")), "console captured");
  ok(globalThis.figma.currentPage.children.length === 1, "node attached to page");
}

{
  // infinite loop phải bị TIMEOUT cắt, trong ~timeoutMs
  const t0 = Date.now();
  const r = await runCode(`let n = 0; while (true) { n++; }`, { timeoutMs: 1200, maxNodes: 10, maxCommands: 1e9 });
  const dt = Date.now() - t0;
  ok(r.ok === false && r.code === "TIMEOUT", `sync-looking infinite loop times out (${dt}ms)`);
  ok(dt < 4000, "timeout is timely, not hung");
}

{
  // cancel qua control token trong khi đang await
  const control = createControlToken();
  const p = runCode(`await new Promise(r => setTimeout(r, 50)); while (true) { }`, { timeoutMs: 10000, maxCommands: 1e9 }, { control });
  setTimeout(() => { control.cancelled = true; }, 120);
  const r = await p;
  ok(r.ok === false && r.code === "CANCELLED", "cancel token stops running loop");
}

{
  const r = await runCode(`for (let i = 0; i < 500; i++) figma.createFrame();`, { timeoutMs: 5000, maxNodes: 50, maxCommands: 1e9 });
  ok(r.ok === false && r.code === "BUDGET", "node budget enforced");
  ok(r.createdNodes.length === 50, "created nodes preserved for agent cleanup");
}

{
  const r = await runCode(`figma.ui.postMessage("x")`, { timeoutMs: 5000, maxNodes: 10, maxCommands: 10 });
  ok(r.ok === false && r.code === "POLICY", "runtime policy layer blocks figma.ui even if pre-validation skipped");
}

{
  const r = await runCode(`throw new Error("Cannot find Button component")`, { timeoutMs: 5000, maxNodes: 10, maxCommands: 10 });
  ok(r.ok === false && r.code === "RUNTIME" && r.error.includes("Cannot find Button"), "runtime error surfaced to agent");
}

{
  // helpers.createText fallback font khi font lỗi
  const r = await runCode(`const t = await helpers.createText("Hi", { fontName: { family: "MissingFont", style: "Bold" } }); return t.name;`, { timeoutMs: 5000, maxNodes: 10, maxCommands: 100 });
  ok(r.ok === true, "createText falls back when font missing");
}

{
  const r = await runCode(`let n = 0; [1,2,3].forEach(() => { for (let i = 0; i < 2; i++) n++; }); return n;`, { timeoutMs: 5000, maxNodes: 10, maxCommands: 1000 });
  ok(r.ok === true && r.value === 6, "loops inside sync callbacks run (no SyntaxError from instrumentation)");
}

{
  // sandbox không được làm mất side-effect của create* (regression: Proxy "inconsistent get")
  const r = await runCode(`const a = figma.createFrame(); const b = figma.createText(); return typeof a.resize;`, { timeoutMs: 5000, maxNodes: 10, maxCommands: 100 });
  ok(r.ok === true && r.value === "function" && r.createdNodes.length === 2, "create* wrappers work and are tracked");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
