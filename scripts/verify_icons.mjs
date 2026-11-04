#!/usr/bin/env node
/**
 * 校验已构建产物里嵌入的 Windows 资源图标，是否与当前品牌资产一致。
 *
 * 为什么需要：图标是把 icon.ico 编译进资源段得到的，一旦构建时用的是旧图标，
 * 光看磁盘上的文件是发现不了的 —— 只能直接检查产物本身。
 *
 * 检查两处：
 *   1) 应用本体 target/<profile>/lshell.exe —— rc.exe 编译资源时原样拷贝 PNG 数据，
 *      字节流里能找到当前 128x128.png / 256x256.png 就说明 exe 里是这版 logo。
 *   2) 安装包 bundle/nsis/*-setup.exe —— 安装程序图标由 tauri.conf.json 的
 *      bundle.windows.nsis.installerIcon 指定；若该项缺失，NSIS 会退回自带的
 *      默认图标（一个带下载箭头的通用图标），此时 PNG 一个都找不到。
 *      （makensis 同样原样写 PNG 条目，所以用同一套字节比对即可。）
 *
 * 用法：
 *   node scripts/verify_icons.mjs            # 自动找 debug/release 产物；安装包存在才校验
 *   node scripts/verify_icons.mjs --release  # 指定 release，且必须有安装包
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = join(ROOT, "src-tauri");

// 参与校验的尺寸：PNG 内容在 ico、exe 资源段、NSIS 安装包里都是原样存放的
const CHECK_PNGS = ["48x48.png", "128x128.png", "256x256.png"];

const releaseOnly = process.argv.includes("--release");

function findExe() {
  const profiles = releaseOnly ? ["release"] : ["debug", "release"];
  for (const p of profiles) {
    const exe = join(TAURI, "target", p, "lshell.exe");
    if (existsSync(exe)) return { exe, profile: p };
  }
  return null;
}

function findInstaller() {
  const dir = join(TAURI, "target", "release", "bundle", "nsis");
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((f) => /-setup\.exe$/i.test(f));
  return name ? join(dir, name) : null;
}

function checkPngs(label, file) {
  const bytes = readFileSync(file);
  console.log(
    `[verify] ${label}：${file}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`
  );
  let ok = true;
  for (const name of CHECK_PNGS) {
    const pngPath = join(TAURI, "icons", name);
    if (!existsSync(pngPath)) {
      console.error(`[verify] 缺少图标文件：src-tauri/icons/${name}`);
      ok = false;
      continue;
    }
    const hit = bytes.includes(readFileSync(pngPath));
    if (!hit) ok = false;
    console.log(
      `         ${name.padEnd(12)} ${hit ? "✓ 已嵌入且为当前版本" : "✗ 未找到 —— 用的是旧图标/默认图标"}`
    );
  }
  return ok;
}

const found = findExe();
if (!found) {
  console.error("[verify] 未找到已构建的 lshell.exe（target/debug 或 target/release）");
  console.error("        先执行 npm run tauri build 或 npm run tauri dev 再来校验。");
  process.exit(2);
}

const installer = findInstaller();
if (!installer && releaseOnly) {
  console.error("[verify] 未找到 NSIS 安装包（target/release/bundle/nsis/*-setup.exe）");
  console.error("        先执行 npm run tauri build 再来校验。");
  process.exit(2);
}

let failed = false;
if (!checkPngs(`应用 exe (${found.profile})`, found.exe)) failed = true;

if (installer) {
  if (!checkPngs("安装包 setup.exe", installer)) failed = true;
} else {
  console.log("[verify] 未找到 NSIS 安装包，跳过安装包图标校验");
}

if (failed) {
  console.error("\n[verify] 失败：产物中的图标与当前品牌资产不一致。");
  console.error("        排查：1) npm run assets 是否执行成功；2) src-tauri/build.rs 是否保留了");
  console.error("        图标的 cargo:rerun-if-changed 声明（否则 cargo 不会重编资源段）；");
  console.error("        3) tauri.conf.json 的 bundle.windows.nsis.installerIcon / uninstallerIcon");
  console.error("        是否指向 icons/icon.ico（缺失时安装包会用 NSIS 默认图标）。");
  process.exit(1);
}

console.log("\n[verify] 通过：exe 与安装包内嵌图标均与当前品牌资产一致。");
