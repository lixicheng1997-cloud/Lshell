#!/usr/bin/env node
/**
 * 生成品牌资产：字标（SVG + Brand.tsx）与应用图标（PNG + ICO）。
 *
 * 打包链路：
 *   make_logo.py  → design/assets/*.svg + wordmark.json + src/components/Brand.tsx
 *   make_icons.py → src-tauri/icons/*.png + icon.ico
 *   icon.ico      → exe 的 Windows 资源（由 src-tauri/build.rs 登记为 cargo 依赖）
 *   Brand.tsx     → dist/ → 前端资源嵌入 exe
 *
 * 这一层做三件事：
 *   1. 自动探测 Python 解释器（python / python3 / py），找不到就明确报错并终止，
 *      绝不「跳过生成」——那会让打包产物用上旧 logo。
 *   2. 生成后校验产物：文件必须存在且时间戳新于本次启动，杜绝脚本静默失败。
 *   3. 打印产物指纹（SHA-256 前 12 位），构建日志里可直接核对打进包的是哪版 logo。
 *
 * 用法：node scripts/gen_assets.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 依次尝试的 Python 解释器
const PYTHON_CANDIDATES = ["python", "python3", "py"];

// 生成脚本 → 需要产出的文件
const STEPS = [
  {
    script: "scripts/make_logo.py",
    outputs: [
      "design/assets/lshell-logo-on-dark.svg",
      "design/assets/lshell-logo-on-light.svg",
      "design/assets/lshell-logo-mono.svg",
      "design/assets/wordmark.json",
      "src/components/Brand.tsx",
    ],
  },
  {
    script: "scripts/make_icons.py",
    outputs: [
      "src-tauri/icons/16x16.png",
      "src-tauri/icons/32x32.png",
      "src-tauri/icons/48x48.png",
      "src-tauri/icons/128x128.png",
      "src-tauri/icons/256x256.png",
      "src-tauri/icons/icon.ico",
    ],
  },
];

function fail(msg, detail) {
  console.error(`\n[assets] 失败：${msg}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function findPython() {
  for (const cmd of PYTHON_CANDIDATES) {
    const args = cmd === "py" ? ["-3", "--version"] : ["--version"];
    const r = spawnSync(cmd, args, { stdio: "ignore" });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

function runPython(cmd, script) {
  const args = cmd === "py" ? ["-3", script] : [script];
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.error) fail(`无法执行 ${cmd}`, r.error.message);
  if (r.status !== 0) fail(`${script} 退出码 ${r.status}`);
}

function sha12(path) {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")
    .slice(0, 12);
}

function hashOf(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const python = findPython();
if (!python) {
  fail(
    "未找到 Python 解释器，无法生成品牌资产。",
    "  请安装 Python 3 并确保 python / python3 / py 之一在 PATH 中。\n" +
      "  （脚本不依赖任何第三方库，纯标准库即可运行）"
  );
}

console.log(`[assets] Python 解释器：${python}`);
const startedAt = Date.now();
const changedFiles = [];

for (const step of STEPS) {
  const scriptPath = join(ROOT, step.script);
  if (!existsSync(scriptPath)) fail(`生成脚本不存在：${step.script}`);

  // 记录生成前的内容指纹：生成器只在内容变化时才落盘，
  // 所以「内容变了」才说明 logo 真的更新了。
  const before = new Map(step.outputs.map((o) => [o, hashOf(join(ROOT, o))]));

  console.log(`[assets] 运行 ${step.script}`);
  runPython(python, step.script);

  for (const out of step.outputs) {
    const p = join(ROOT, out);
    if (!existsSync(p)) fail(`产物缺失：${out}（${step.script} 未写出生效文件）`);
    const after = hashOf(p);
    const changed = before.get(out) !== after;
    const rewritten = statSync(p).mtimeMs >= startedAt - 1000;
    // 内容变了就必须真的重写过（否则说明写盘逻辑有 bug）
    if (changed && !rewritten) {
      fail(`产物内容已变但未重新落盘：${out}`);
    }
    if (changed) changedFiles.push(out);
  }
}

console.log(
  changedFiles.length
    ? `[assets] 本轮更新的产物：${changedFiles.length} 个（logo 有变化，exe 资源会随之重编译）`
    : "[assets] 产物内容与上次一致，未改动文件（构建可走增量）"
);
console.log("[assets] 全部产物已生成并校验通过");
for (const f of [
  "design/assets/wordmark.json",
  "src-tauri/icons/icon.ico",
  "src/components/Brand.tsx",
]) {
  console.log(`         ${f}  sha256:${sha12(join(ROOT, f))}`);
}
