#!/usr/bin/env node
/**
 * 校验已构建的 exe 里嵌入的 Windows 资源图标，是否与当前品牌资产一致。
 *
 * 为什么需要：exe 的图标是把 icon.ico 编译进资源段得到的，
 * 一旦构建时用的是旧图标，光看磁盘上的文件是发现不了的 ——
 * 只能直接检查产物本身。
 *
 * 原理：icon.ico 内部以 PNG 形式存放各尺寸图像，而 rc.exe 编译资源时
 * 会原样拷贝 PNG 数据。所以只要 exe 字节流里能找到当前 128x128.png
 * 的完整内容，就说明打进包里的就是这个版本的 logo。
 *
 * 用法：
 *   node scripts/verify_icons.mjs            # 自动找 debug/release 产物
 *   node scripts/verify_icons.mjs --release  # 指定 release
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = join(ROOT, "src-tauri");

// 参与校验的尺寸：PNG 内容在 ico 与资源段里都是原样存放的
const CHECK_PNGS = ["128x128.png", "256x256.png"];

function findExe() {
  const profiles = process.argv.includes("--release")
    ? ["release"]
    : ["debug", "release"];
  for (const p of profiles) {
    const exe = join(TAURI, "target", p, "lshell.exe");
    if (existsSync(exe)) return { exe, profile: p };
  }
  return null;
}

const found = findExe();
if (!found) {
  console.error("[verify] 未找到已构建的 lshell.exe（target/debug 或 target/release）");
  console.error("        先执行 npm run tauri build 或 npm run tauri dev 再来校验。");
  process.exit(2);
}

const { exe, profile } = found;
const exeBytes = readFileSync(exe);
console.log(`[verify] 产物：${exe}  (${(exeBytes.length / 1024 / 1024).toFixed(1)} MB, ${profile})`);

let failed = false;
for (const name of CHECK_PNGS) {
  const pngPath = join(TAURI, "icons", name);
  if (!existsSync(pngPath)) {
    console.error(`[verify] 缺少图标文件：src-tauri/icons/${name}`);
    failed = true;
    continue;
  }
  const png = readFileSync(pngPath);
  const ok = exeBytes.includes(png);
  if (!ok) failed = true;
  console.log(
    `         ${name.padEnd(12)} ${ok ? "✓ 已嵌入且为当前版本" : "✗ 未找到 —— exe 里是旧图标"}`
  );
}

if (failed) {
  console.error("\n[verify] 失败：exe 中的图标与当前品牌资产不一致。");
  console.error("        排查：1) npm run assets 是否执行成功；2) src-tauri/build.rs 是否保留了");
  console.error("        图标的 cargo:rerun-if-changed 声明（否则 cargo 不会重编资源段）。");
  process.exit(1);
}

console.log("\n[verify] 通过：exe 内嵌图标与当前品牌资产一致。");
