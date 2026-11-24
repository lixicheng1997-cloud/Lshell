#!/usr/bin/env node
/**
 * 校验主题表的结构性约束。
 *
 * 主题定义在 TypeScript 里，构建期无法直接 import，因此这里读取源码做文本级断言：
 *   1. 每个主题族必须同时有 darkId / lightId，全局深浅数量天然相等；
 *   2. 经典主题已移除，旧 id 迁移到默认定制主题；
 *   3. 生成器主题的关键色齐全，且前景/背景对比度达到 WCAG AA 正文标准（4.5:1）；
 *   4. 主题自带的插画资源确实存在于源码树中。
 *
 * 用法：node scripts/verify_themes.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(ROOT, "src/lib/app-themes.ts"), "utf8");

const failures = [];
const info = [];
function check(ok, message) {
  if (!ok) failures.push(message);
}

// ---------- 族成对 ----------

const families = [...source.matchAll(/darkId:\s*"([^"]+)",\s*lightId:\s*"([^"]+)"/g)].map(
  (m) => ({ dark: m[1], light: m[2] })
);
check(families.length === 5, `主题族数量应为 5，实际 ${families.length}`);
info.push(`主题族：${families.length}（深色 ${families.length} / 浅色 ${families.length}）`);

const themeBlock = source.match(/const THEMES_RAW[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1] ?? "";
const definedIds = [...themeBlock.matchAll(/^\s{2}"?([a-z][a-z0-9-]*)"?:\s*[A-Z_]+,/gim)].map(
  (m) => m[1]
);
check(new Set(definedIds).size === definedIds.length, "THEMES_RAW 中存在重复 id");
info.push(`主题数量：${definedIds.length}`);

for (const family of families) {
  check(definedIds.includes(family.dark), `族 ${family.dark} 缺少深色主题`);
  check(definedIds.includes(family.light), `族 ${family.light} 缺少浅色主题`);
}

const LEGACY_IDS = [
  "dark", "light", "dracula", "nord", "solarized-dark", "solarized-light",
  "gruvbox-dark", "tokyo-night", "one-dark", "catppuccin-mocha",
];
for (const id of LEGACY_IDS) {
  check(!definedIds.includes(id), `经典主题未被移除：${id}`);
}

// ---------- 生成器主题的色值与对比度 ----------

function luminance(hex) {
  const channels = hex
    .replace("#", "")
    .match(/../g)
    .map((h) => parseInt(h, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const generated = [
  ...source.matchAll(/makeTheme\(\s*"([^"]+)",\s*"[^"]+",\s*"(dark|light)",\s*\{([\s\S]*?)\}\s*\)/g),
];
check(generated.length === 10, `定制主题数量应为 10，实际 ${generated.length}`);

for (const [, id, mode, body] of generated) {
  for (const key of ["bg:", "panel:", "surface:", "fg:", "accent:", "ok:", "warn:", "err:", "info:"]) {
    check(body.includes(key), `主题 ${id} 缺少关键色 ${key}`);
  }
  const bg = body.match(/bg:\s*"(#[0-9A-Fa-f]{6})"/)?.[1];
  const fg = body.match(/fg:\s*"(#[0-9A-Fa-f]{6})"/)?.[1];
  if (bg && fg) {
    const ratio = contrast(bg, fg);
    check(ratio >= 4.5, `主题 ${id}（${mode}）正文对比度 ${ratio.toFixed(2)}:1 < 4.5:1`);
  }
}
info.push(`生成器主题：${generated.length}，全部正文对比度 ≥ 4.5:1`);

// ---------- 插画资源 ----------

// 带插画的族：素色族是纯色主题，本来就不需要插画
const expectedArt = [
  "cloud-night", "cloud-day", "peach-night", "peach-day",
  "starry-night", "starry-day", "mint-night", "mint-day",
];
const artPaths = expectedArt.map((name) =>
  resolve(ROOT, "src/assets/themes", `${name}.png`)
);
for (const path of artPaths) {
  check(existsSync(path), `主题插画资源不存在：${path}`);
}
// 素色族不应带插画，否则「纯黑 / 纯白」就不纯了
const monoFamily = source.match(/id: "mono"[\s\S]*?\n  \},/)?.[0] ?? "";
check(
  !monoFamily.includes("artwork"),
  "素色族不应带插画"
);
info.push(`主题插画资源：${artPaths.length}`);

// ---------- 主题列表 ----------

check(
  !/id: "system"/.test(source),
  "主题列表不应再包含「跟随系统」"
);
check(
  /DEFAULT_THEME_ID = "cloud-night"/.test(source),
  "默认主题应为云朵棉花糖 cloud-night"
);

// ---------- 结果 ----------

for (const line of info) console.log(`  ${line}`);
if (failures.length) {
  console.error("\n主题校验失败：");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("主题校验通过。");
