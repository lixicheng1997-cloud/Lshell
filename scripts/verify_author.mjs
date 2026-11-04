#!/usr/bin/env node
/**
 * 校验打包产物里的作者元数据。
 *
 * 三个落点分别对应三套机制，需逐一核对：
 *   1. exe 的 Windows 版本资源 —— CompanyName / LegalCopyright
 *   2. MSI 的 Property 表     —— Manufacturer
 *   3. NSIS 安装包内的字符串   —— Publisher（注册表项）
 *
 * 用法：node scripts/verify_author.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "src-tauri", "target", "release", "bundle");
const EXPECTED = "xichengli";

let failed = 0;

/** 断言相等，不等则计为失败 */
function check(label, actual, expected = EXPECTED) {
  const normalized = normalizeConsole(actual);
  const ok = normalized.trim() === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "[OK]" : "[!!]"} ${label}: ${JSON.stringify(normalized)}`);
  console.log(`      期望: ${JSON.stringify(expected)}`);
}

/** 从 exe 字节流里读 Windows 版本资源的字符串字段 */
function readExeVersionInfo(exePath) {
  // 用 PowerShell 的 VersionInfo 读取资源段里的字符串表。
  // 注意：控制台编码可能把 © 显示成 ?，
  // 所以这里额外做一次字节级核对（见 verifyCopyrightBytes）。
  const ps = `$v=[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${exePath.replace(/'/g, "''")}');
$o=@{}; foreach($p in @('CompanyName','LegalCopyright','ProductName','FileDescription','ProductVersion')){ $o[$p]=$v.$p }; $o | ConvertTo-Json -Compress`;
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", ps],
    { encoding: "utf8" }
  );
  return JSON.parse(out);
}

/**
 * 字节级核对版权字符串。
 *
 * PowerShell 控制台按 OEM 代码页输出，© 常被显示成 ?，
 * 但 exe 里的 UTF-16LE 字节本身是对的 —— 以字节为准。
 */
function verifyCopyrightBytes(exePath, expected) {
  const buf = readFileSync(exePath);
  return buf.includes(Buffer.from(expected, "utf16le"));
}

/**
 * 归一化后再比较：把控制台替换出来的 ? 还原成 ©。
 *
 * 只用于比对，不改文件。
 */
function normalizeConsole(s) {
  return String(s).replace(/Copyright \? (\d{4})/, "Copyright © $1");
}

/** 在二进制里搜一个 ASCII 字符串是否出现（UTF-16LE 也一并检查） */
function containsString(filePath, needle) {
  const buf = readFileSync(filePath);
  const ascii = buf.includes(Buffer.from(needle, "ascii"));
  const utf16 = buf.includes(Buffer.from(needle, "utf16le"));
  return ascii || utf16;
}

console.log(`作者元数据校验（期望 "${EXPECTED}"）\n`);

// ---------- 1. exe 版本资源 ----------
const exe = join(ROOT, "src-tauri", "target", "release", "lshell.exe");
if (!existsSync(exe)) {
  console.log("  [!!] 未找到 release/lshell.exe，跳过 exe 校验\n");
  failed++;
} else {
  console.log("1) exe Windows 版本资源");
  const info = readExeVersionInfo(exe);
  check("CompanyName", info.CompanyName);
  check("LegalCopyright", info.LegalCopyright, `Copyright © 2026 ${EXPECTED}`);
  check("ProductName", info.ProductName, "Lshell");
  check("ProductVersion", info.ProductVersion, "1.0.0");

  // 控制台可能把 © 显示成 ?，用字节再确认一次
  const copyrightOk = verifyCopyrightBytes(exe, `Copyright © 2026 ${EXPECTED}`);
  if (!copyrightOk) failed++;
  console.log(
    `  ${copyrightOk ? "[OK]" : "[!!]"} LegalCopyright 字节级核对 (UTF-16LE)`
  );
  console.log("");
}

// ---------- 2. MSI ----------
const msiDir = join(BUNDLE, "msi");
if (!existsSync(msiDir)) {
  console.log("  [!!] 未找到 msi/ 目录，跳过 MSI 校验\n");
  failed++;
} else {
  console.log("2) MSI 安装包");
  const msi = readdirSync(msiDir).find((f) => f.endsWith(".msi"));
  if (!msi) {
    console.log("  [!!] msi/ 下没有 .msi 文件\n");
    failed++;
  } else {
    const msiPath = join(msiDir, msi);
    console.log(`  文件: ${msi}`);
    // MSI 里的字符串以 UTF-16LE 存储，直接搜字节流
    const hasAuthor = containsString(msiPath, EXPECTED);
    console.log(`  ${hasAuthor ? "[OK]" : "[!!]"} MSI 内含 "${EXPECTED}"`);
    if (!hasAuthor) failed++;
    console.log("");
  }
}

// ---------- 3. NSIS ----------
const nsisDir = join(BUNDLE, "nsis");
if (!existsSync(nsisDir)) {
  console.log("  [!!] 未找到 nsis/ 目录，跳过 NSIS 校验\n");
  failed++;
} else {
  console.log("3) NSIS 安装包");
  const setup = readdirSync(nsisDir).find((f) => f.endsWith(".exe"));
  if (!setup) {
    console.log("  [!!] nsis/ 下没有 .exe 文件\n");
    failed++;
  } else {
    const setupPath = join(nsisDir, setup);
    console.log(`  文件: ${setup}`);
    const hasAuthor = containsString(setupPath, EXPECTED);
    console.log(`  ${hasAuthor ? "[OK]" : "[!!]"} NSIS 内含 "${EXPECTED}"`);
    if (!hasAuthor) failed++;
    console.log("");
  }
}

if (failed > 0) {
  console.log(`校验未通过：${failed} 项异常`);
  process.exit(1);
}
console.log("全部通过");
