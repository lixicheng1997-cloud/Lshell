// 读取仓库根目录的 .env 注入环境变量，再执行 tauri 命令。
// Tauri CLI 本身不会加载 .env，因此签名私钥等变量需要通过本脚本传入。
// 用法：node scripts/tauri-build.mjs build
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// 用 process.cwd() 作为项目根目录：npm scripts 总是从仓库根执行。
// 注意不能用脚本自身路径推导——scripts/ 目录在本机是指向别处的 junction，
// Node 解析 realpath 后会得到错误的根目录。
const root = process.cwd();
const envFile = path.join(root, ".env");

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    // 已在 shell 里显式设置的变量优先，不被 .env 覆盖
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    // 若值是存在的文件路径（如私钥文件），读取其内容注入
    if (value && existsSync(value)) {
      value = readFileSync(value, "utf8");
    }
    process.env[key] = value;
  }
} else {
  console.warn("[tauri-build] 未找到 .env，将仅使用当前 shell 的环境变量");
}

const tauriBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri"
);

const res = spawnSync(tauriBin, process.argv.slice(2), {
  cwd: root,
  stdio: "inherit",
  shell: true, // Windows 下 spawn .cmd 必须经由 shell
});
if (res.error) {
  console.error("[tauri-build]", res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
