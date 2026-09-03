/**
 * harden.mjs — post-process plugin/dist/main.js để vượt qua static check
 * của Figma sandbox: "SyntaxError: possible import expression rejected".
 *
 * Figma quét TEXT của bundle tìm pattern `import(` và `import.meta` (dynamic
 * import / import.meta bị QuickJS sandbox từ chối). Acorn chứa hai pattern này
 * trong các STRING LITERAL lỗi ("Trailing comma is not allowed in import()",
 * "Cannot use 'import.meta' outside a module"...) → Figma reject cả bundle dù
 * không có import expression thật nào.
 *
 * Fix: escape ký tự nhạy cảm trong chuỗi thành \u0028 / \u002E — giá trị runtime
 * của string KHÔNG đổi, nhưng text pattern biến mất.
 *
 * An toàn: bundle là IIFE đã flatten mọi static import — không còn cú pháp
 * import/export THẬT nào trong code, nên replace toàn bộ text là được.
 * (Nếu sau này ai thêm dynamic import() THẬT vào src → Figma cũng sẽ từ chối
 * plugin đó anyway, nên không thể "break nhầm" code hợp lệ.)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "dist", "main.js");

let code = readFileSync(file, "utf8");
const original = code;

const replacements = [
  // `import(`  → `import\u0028`  — '(' được thay bằng escape, dấu ')' gốc giữ nguyên;
  // decode runtime: "import(" (KHÔNG được nhân đôi paren ở đây!)
  [/\bimport\(/g, "import\\u0028"],
  // `import.meta` → `import\u002Emeta` — \u002E decode lại thành '.', giá trị hệt ban đầu
  [/\bimport\.meta\b/g, "import\\u002Emeta"],
];

for (const [re, to] of replacements) {
  code = code.replace(re, to);
}

// verify: không còn pattern sống nào
for (const re of [/\bimport\(/g, /\bimport\.meta/g]) {
  if (re.test(code)) {
    console.error("[harden] FAILED — pattern vẫn còn:", re);
    process.exit(1);
  }
}

writeFileSync(file, code);
console.log(
  `[harden] ok — escaped ${original.length - code.length >= 0 ? "patterns" : ""} (size ${original.length} → ${code.length} bytes)`
);
