/**
 * 界面字体注册表。
 *
 * 字体栈与主题解耦：主题只提供推荐 id，用户可以在设置里手动覆盖。
 *
 * 「站酷快乐体」「站酷小薇体」两款可爱字体已内置进包
 * （见 src/assets/fonts/ 与 src/styles/fonts.css，SIL OFL 1.1 可商用），
 * 因此这两项在任何机器上都能真正生效，不再因为「没装字体」而静默回落。
 * 其余选项依赖系统字体，未安装时自动回落到后备栈。
 *
 * 终端字体不在这里 —— 终端必须等宽，注册表在 SettingsDialog.tsx，
 * 默认值在 settings.ts 的 DEFAULT_TERM_FONT_FAMILY。
 */

export interface FontChoice {
  id: string;
  label: string;
  stack: string;
  note?: string;
  /** 是否随包内置（内置项不需要用户另行安装） */
  bundled?: boolean;
}

const SYSTEM =
  '"Segoe UI Variable Text", -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';
/**
 * 内置：等宽可爱字体。
 *
 * 中文字形来自站酷快乐体 / 站酷小薇体，英文字形是等宽的，
 * 中英 2:1 精确对齐 —— 界面与终端可以真正共用同一款字体。
 */
const CUTE_ROUND =
  '"Lshell Mono KuaiLe", "ZCOOL KuaiLe", "站酷快乐体", YouYuan, "幼圆", "Microsoft YaHei UI", sans-serif';
const CUTE_SERIF =
  '"Lshell Mono XiaoWei", "ZCOOL XiaoWei", "站酷小薇体", STHupo, "华文琥珀", "Microsoft YaHei UI", sans-serif';
const STORY =
  '"Smiley Sans", "得意黑", "Hiragino Sans GB", "Microsoft YaHei UI", sans-serif';
const FRESH =
  '"HarmonyOS Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif';


/** 主题可引用的字体栈 */
export const UI_FONT_STACKS = {
  system: SYSTEM,
  "cute-round": CUTE_ROUND,
  "cute-serif": CUTE_SERIF,
  story: STORY,
  fresh: FRESH,
} as const;

export type UiFontId = keyof typeof UI_FONT_STACKS;

/** 设置里可选的界面字体，顺序即显示顺序 */
export const UI_FONT_OPTIONS: FontChoice[] = [
  { id: "system", label: "系统默认（简洁）", stack: SYSTEM },
  {
    id: "cute-round",
    label: "圆润可爱",
    stack: CUTE_ROUND,
    bundled: true,
    note: "内置等宽中文字体，界面与终端可共用同一款",
  },
  {
    id: "cute-serif",
    label: "俏皮手写",
    stack: CUTE_SERIF,
    bundled: true,
    note: "内置等宽中文字体，界面与终端可共用同一款",
  },
  {
    id: "story",
    label: "绘本圆体",
    stack: STORY,
    note: "得意黑，未安装时回落为系统字体",
  },
  { id: "fresh", label: "清爽现代", stack: FRESH },
];

/** 把字体 id 解析为完整 CSS 字体栈；未知 id 回落系统默认 */
export function uiFontStack(id: string): string {
  return UI_FONT_STACKS[id as UiFontId] ?? SYSTEM;
}

/** 用于设置界面显示的字体名 */
export function uiFontLabel(id: string): string {
  return UI_FONT_OPTIONS.find((option) => option.id === id)?.label ?? "系统默认（简洁）";
}

/**
 * 界面的首选字体名（用于检测与示例渲染）。
 *
 * 解析的是字体栈里的第一个具名字族；-apple-system 这类泛型族不算。
 */
export function uiFontFamily(id: string): string {
  const choice = UI_FONT_OPTIONS.find((option) => option.id === id);
  if (!choice) return "Microsoft YaHei UI";
  const first = choice.stack.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  if (!first || first.startsWith("-apple")) return "Microsoft YaHei UI";
  return first;
}
