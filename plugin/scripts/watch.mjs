/**
 * watch.mjs — esbuild watch + chạy harden sau mỗi lần rebuild.
 * (esbuild CLI --watch không có post-hook, dùng JS API + onEnd result.)
 */
import { spawn } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const esbuildArgs = [
  "esbuild",
  "src/main.js",
  "--bundle",
  "--format=iife",
  "--target=es2017",
  "--outfile=dist/main.js",
  "--watch=quiet",
];

function harden() {
  try {
    console.log(execSync("node scripts/harden.mjs", { cwd: root }).toString().trim());
  } catch (e) {
    console.error(e.stdout?.toString() || e.message);
  }
}

const child = spawn(process.platform === "win32" ? "npx" : "npx", esbuildArgs, {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
  shell: process.platform === "win32",
});

// esbuild --watch in "CHANGE" khi rebuild → harden theo
child.stdout?.on("data", () => {}); // placeholder (watch=quiet im lặng); fallback dưới đây mới chắc chắn
let t = null;
fsWatch(join(root, "src"), { recursive: true }, () => {
  clearTimeout(t);
  t = setTimeout(harden, 400); // đợi esbuild ghi xong dist/main.js
});
harden(); // lần build đầu
console.log("[plugin] watching src/ → dist/main.js (+harden)");
