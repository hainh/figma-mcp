/**
 * watch.mjs — esbuild watch (code.ts → code.js) + chạy harden sau mỗi lần rebuild.
 * Dùng JS API + plugin onEnd hook (CLI --watch không có post-hook).
 */
import { context } from "esbuild";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function harden() {
  try {
    console.log(execSync("node scripts/harden.mjs", { cwd: root }).toString().trim());
  } catch (e) {
    console.error(e.stdout?.toString() || e.message);
  }
}

const hardenPlugin = {
  name: "harden",
  setup(build) {
    // chạy sau mỗi rebuild thành công (esbuild đã ghi xong code.js)
    build.onEnd((result) => {
      if (result.errors.length === 0) harden();
    });
  },
};

const ctx = await context({
  entryPoints: [join(root, "code.ts")],
  bundle: true,
  format: "iife",
  target: "es2017",
  outfile: join(root, "code.js"),
  sourcemap: true,
  absWorkingDir: root,
  logLevel: "warning",
  plugins: [hardenPlugin],
});

await ctx.watch();
console.log("[plugin] watching code.ts + src/ → code.js (+harden)");
