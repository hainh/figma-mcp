/**
 * map-stack.mjs — map stack trace từ Figma (vị trí "code.js:line:col", hoặc tên
 * hàm trong bundle) về vị trí src/*.ts gốc. Figma QuickJS sandbox KHÔNG tự áp
 * source map khi in stack → tool này đọc code.js.map (bản build --sourcemap).
 *
 * Usage:
 *   node scripts/map-stack.mjs "<stack text>"        # truyền trực tiếp
 *   node scripts/map-stack.mjs --file crash.log      # đọc từ file
 *   echo "<stack>" | node scripts/map-stack.mjs      # hoặc stdin
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let text = "";
const args = process.argv.slice(2);
if (args[0] === "--file") {
  text = readFileSync(args[1], "utf8");
} else if (args.length) {
  text = args.join(" ");
} else {
  text = readFileSync(0, "utf8"); // stdin
}

const map = JSON.parse(readFileSync(join(root, "code.js.map"), "utf8"));
const consumer = await new SourceMapConsumer(map);

// các pattern vị trí phổ biến trong stack: "code.js:123:45", "plugin code:123:45", ":123:45)" đứng sau code.js
const posRe = /(?:code\.js|plugin code|main\.js)[:\s](\d+):(\d+)/g;

const output = text.replace(posRe, (full, line, col) => {
  const orig = consumer.originalPositionFor({ line: Number(line), column: Math.max(0, Number(col) - 1) });
  if (orig.source == null) return `${full} [not in map]`;
  return `${full} → ${orig.source}:${orig.line}:${(orig.column ?? 0) + 1}${orig.name ? ` (${orig.name})` : ""}`;
});

console.log(output.trimEnd());
consumer.destroy();
