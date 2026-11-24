/**
 * 统一主题表。
 *
 * 每套主题同时定义应用界面色板与 xterm 终端配色；
 * 主题族固定包含深浅各一套，主题列表按族平铺展示。
 */
import type { ITheme } from "@xterm/xterm";
import { UI_FONT_STACKS } from "./fonts";

export type ThemeMode = "dark" | "light";
export type ShapeId = "crisp" | "round" | "soft";

/** 形态层：圆角、面板材质、动效与排版密度 */
export interface ThemeShape {
  id: ShapeId;
  radius: [string, string, string, string];
  pill: string;
  /** 面板与终端共用的不透明度 */
  veil: number;
  duration: string;
  ease: string;
  labelSpacing: string;
  labelWeight: number;
}

/** 主题内置插画，Vite 静态打包 */
export interface ThemeArtwork {
  src: string;
  opacity: number;
  fit: "cover" | "contain" | "tile";
  blur: number;
}

export interface ThemeFonts {
  ui: string;
}

export interface ThemeFamily {
  id: string;
  name: string;
  darkId: string;
  lightId: string;
  shape: ShapeId;
  fonts: ThemeFonts;
  artwork?: Partial<Record<ThemeMode, ThemeArtwork>>;
}

export const SHAPES: Record<ShapeId, ThemeShape> = {
  crisp: {
    id: "crisp",
    radius: ["6px", "9px", "14px", "18px"],
    pill: "999px",
    veil: 0,
    duration: "150ms",
    ease: "cubic-bezier(.4, 0, .2, 1)",
    labelSpacing: ".12em",
    labelWeight: 700,
  },
  round: {
    id: "round",
    radius: ["10px", "14px", "20px", "26px"],
    pill: "999px",
    veil: 0,
    duration: "220ms",
    ease: "cubic-bezier(.34, 1.16, .64, 1)",
    labelSpacing: ".08em",
    labelWeight: 600,
  },
  soft: {
    id: "soft",
    radius: ["8px", "12px", "18px", "24px"],
    pill: "999px",
    veil: 0,
    duration: "190ms",
    ease: "cubic-bezier(.2, .8, .3, 1)",
    labelSpacing: ".06em",
    labelWeight: 600,
  },
};

// ---------- 色板工具 ----------

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const channel = (x: number, y: number) =>
    Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface AppPalette {
  bgApp: string;
  bgPanel: string;
  bgSurface: string;
  bgRaised: string;
  bgHover: string;
  bgActive: string;
  bgSunken: string;
  lineFaint: string;
  line: string;
  lineStrong: string;
  fg: string;
  fgMuted: string;
  fgFaint: string;
  fgOnAccent: string;
  accent: string;
  accentHover: string;
  accentPress: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
}

export interface AppTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  app: AppPalette;
  terminal: ITheme;
  family?: string;
  shape?: ShapeId;
  fonts?: ThemeFonts;
  artwork?: ThemeArtwork;
}

interface ThemeSeed {
  bg: string;
  panel: string;
  surface: string;
  fg: string;
  accent: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  magenta?: string;
}

/** 从少量关键色派生完整色板与 ANSI 16 色 */
function makeTheme(
  id: string,
  name: string,
  mode: ThemeMode,
  seed: ThemeSeed
): AppTheme {
  const dark = mode === "dark";
  const app: AppPalette = {
    bgApp: seed.bg,
    bgPanel: seed.panel,
    bgSurface: seed.surface,
    bgRaised: mix(seed.surface, seed.fg, dark ? 0.07 : 0.04),
    bgHover: mix(seed.surface, seed.fg, dark ? 0.12 : 0.07),
    bgActive: mix(seed.surface, seed.fg, dark ? 0.19 : 0.13),
    bgSunken: mix(seed.bg, dark ? "#000000" : "#ffffff", dark ? 0.28 : 0.3),
    lineFaint: mix(seed.bg, seed.fg, 0.08),
    line: mix(seed.bg, seed.fg, dark ? 0.17 : 0.15),
    lineStrong: mix(seed.bg, seed.fg, dark ? 0.27 : 0.25),
    fg: seed.fg,
    fgMuted: mix(seed.fg, seed.bg, dark ? 0.33 : 0.31),
    fgFaint: mix(seed.fg, seed.bg, dark ? 0.55 : 0.52),
    fgOnAccent: dark ? seed.bg : "#FFFFFF",
    accent: seed.accent,
    accentHover: mix(seed.accent, dark ? "#ffffff" : "#000000", dark ? 0.18 : 0.12),
    accentPress: mix(seed.accent, "#000000", dark ? 0.14 : 0.2),
    ok: seed.ok,
    warn: seed.warn,
    err: seed.err,
    info: seed.info,
  };
  const magenta = seed.magenta ?? mix(seed.accent, seed.fg, 0.4);
  const bright = (color: string) =>
    mix(color, dark ? "#ffffff" : "#000000", dark ? 0.2 : 0.14);
  const terminal: ITheme = {
    background: seed.bg,
    foreground: seed.fg,
    cursor: seed.accent,
    cursorAccent: seed.bg,
    selectionBackground: rgba(seed.accent, dark ? 0.28 : 0.2),
    black: app.line,
    red: seed.err,
    green: seed.ok,
    yellow: seed.warn,
    blue: seed.accent,
    magenta,
    cyan: seed.info,
    white: seed.fg,
    brightBlack: app.lineStrong,
    brightRed: bright(seed.err),
    brightGreen: bright(seed.ok),
    brightYellow: bright(seed.warn),
    brightBlue: bright(seed.accent),
    brightMagenta: bright(magenta),
    brightCyan: bright(seed.info),
    brightWhite: mix(seed.fg, dark ? "#ffffff" : "#000000", 0.12),
  };
  return { id, name, mode, app, terminal, family: "", shape: "crisp" };
}

// ---------- 4 个定制族 × 深浅各一套 ----------

const CLOUD_NIGHT = makeTheme("cloud-night", "云朵棉花糖 · 夜云", "dark", {
  bg: "#1C1B2E", panel: "#26243C", surface: "#302E49", fg: "#EDE8FF",
  accent: "#B9A4FF", ok: "#8FE3C2", warn: "#FFD49A", err: "#FF9BA8", info: "#9BD8FF",
});
const CLOUD_DAY = makeTheme("cloud-day", "云朵棉花糖 · 日云", "light", {
  bg: "#F7F3FF", panel: "#EEE8FC", surface: "#FFFFFF", fg: "#3B3358",
  accent: "#7B61D1", ok: "#3E9E79", warn: "#B77A24", err: "#C94F6A", info: "#4A8FC7",
});
const PEACH_NIGHT = makeTheme("peach-night", "蜜桃奶盖 · 蜜桃夜", "dark", {
  bg: "#2A1F26", panel: "#352831", surface: "#42313C", fg: "#FFEDE8",
  accent: "#FFB39B", ok: "#A8DCB1", warn: "#FFD58A", err: "#FF8E8E", info: "#A8CBEA",
});
const PEACH_DAY = makeTheme("peach-day", "蜜桃奶盖 · 蜜桃日", "light", {
  bg: "#FFF8F3", panel: "#FBEDE5", surface: "#FFFFFF", fg: "#4A332E",
  accent: "#D96F4E", ok: "#4D9A6A", warn: "#B57B1E", err: "#C44B4B", info: "#4E86A8",
});
const STARRY_NIGHT = makeTheme("starry-night", "星夜绘本 · 星夜", "dark", {
  bg: "#1B1B33", panel: "#23233F", surface: "#2E2E4C", fg: "#E8E6FF",
  accent: "#9C93FF", ok: "#83D6B0", warn: "#F3D38D", err: "#F28C99", info: "#8FCBE8",
});
const STARRY_DAY = makeTheme("starry-day", "星夜绘本 · 晨光", "light", {
  bg: "#F7F8FF", panel: "#ECEEFF", surface: "#FFFFFF", fg: "#36385E",
  accent: "#6B62C9", ok: "#438C6A", warn: "#A87A21", err: "#C05568", info: "#447FA6",
});
const MINT_NIGHT = makeTheme("mint-night", "薄荷汽水 · 深薄荷", "dark", {
  bg: "#142622", panel: "#1C322C", surface: "#254037", fg: "#E4FFF4",
  accent: "#7EE0B8", ok: "#A6E86F", warn: "#F2CF7A", err: "#FF8E8E", info: "#7CCBD9",
});
const MINT_DAY = makeTheme("mint-day", "薄荷汽水 · 浅薄荷", "light", {
  bg: "#F2FBF7", panel: "#E6F5EE", surface: "#FFFFFF", fg: "#26453A",
  accent: "#2E9E77", ok: "#4E9440", warn: "#A8801E", err: "#C05050", info: "#3B899C",
});

/**
 * 素色族：纯黑与纯白。
 *
 * 不带插画，底色就是纯粹的 #000000 / #FFFFFF；
 * 表面层次靠极小幅度的灰阶派生，保证面板之间仍然分得开。
 */
const PURE_BLACK = makeTheme("pure-black", "素色 · 纯黑", "dark", {
  bg: "#000000", panel: "#000000", surface: "#0D0D0D", fg: "#F5F5F5",
  accent: "#F0F0F0", ok: "#8FD9A8", warn: "#F0D08A", err: "#F09A9A", info: "#9AC7F0",
});
const PURE_WHITE = makeTheme("pure-white", "素色 · 纯白", "light", {
  bg: "#FFFFFF", panel: "#FFFFFF", surface: "#FAFAFA", fg: "#0D0D0D",
  accent: "#141414", ok: "#2E7D4F", warn: "#8A6212", err: "#B3372F", info: "#2A6FB0",
});

function artwork(file: string, opacity = 1): ThemeArtwork {
  return {
    src: new URL(`../assets/themes/${file}`, import.meta.url).href,
    opacity,
    fit: "cover",
    blur: 0,
  };
}

export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: "cloud", name: "云朵棉花糖",
    darkId: "cloud-night", lightId: "cloud-day", shape: "round",
    fonts: { ui: UI_FONT_STACKS["cute-round"] },
    artwork: { dark: artwork("cloud-night.png"), light: artwork("cloud-day.png") },
  },
  {
    id: "peach", name: "蜜桃奶盖",
    darkId: "peach-night", lightId: "peach-day", shape: "soft",
    fonts: { ui: UI_FONT_STACKS["cute-serif"] },
    artwork: { dark: artwork("peach-night.png"), light: artwork("peach-day.png") },
  },
  {
    id: "starry-book", name: "星夜绘本",
    darkId: "starry-night", lightId: "starry-day", shape: "round",
    fonts: { ui: UI_FONT_STACKS.story },
    artwork: { dark: artwork("starry-night.png"), light: artwork("starry-day.png") },
  },
  {
    id: "mint", name: "薄荷汽水",
    darkId: "mint-night", lightId: "mint-day", shape: "crisp",
    fonts: { ui: UI_FONT_STACKS.fresh },
    artwork: { dark: artwork("mint-night.png"), light: artwork("mint-day.png") },
  },
  {
    // 素色族不带插画：底色就是纯黑 / 纯白本身
    id: "mono", name: "素色",
    darkId: "pure-black", lightId: "pure-white", shape: "crisp",
    fonts: { ui: UI_FONT_STACKS.system },
  },
];

const THEMES_RAW: Record<string, AppTheme> = {
  "cloud-night": CLOUD_NIGHT,
  "cloud-day": CLOUD_DAY,
  "peach-night": PEACH_NIGHT,
  "peach-day": PEACH_DAY,
  "starry-night": STARRY_NIGHT,
  "starry-day": STARRY_DAY,
  "mint-night": MINT_NIGHT,
  "mint-day": MINT_DAY,
  "pure-black": PURE_BLACK,
  "pure-white": PURE_WHITE,
};

/** 把族元数据注入主题；经典主题已下线，旧 id 迁移到默认定制主题 */
function decorateAll(raw: Record<string, AppTheme>): Record<string, AppTheme> {
  const result: Record<string, AppTheme> = {};
  for (const [id, theme] of Object.entries(raw)) {
    const family = THEME_FAMILIES.find(
      (item) => item.darkId === id || item.lightId === id
    );
    result[id] = {
      ...theme,
      family: family?.id ?? "starry-book",
      shape: family?.shape ?? "round",
      fonts: family?.fonts ?? { ui: UI_FONT_STACKS.story },
      artwork: family?.artwork?.[theme.mode],
    };
  }
  return result;
}

const THEMES = decorateAll(THEMES_RAW);

export interface ThemeOption {
  id: string;
  name: string;
  mode: ThemeMode;
}

/** 主题列表：按族平铺展示深浅两套 */
export const THEME_OPTIONS: ThemeOption[] = THEME_FAMILIES.flatMap((family) => [
  { id: family.darkId, name: THEMES[family.darkId].name, mode: "dark" as const },
  { id: family.lightId, name: THEMES[family.lightId].name, mode: "light" as const },
]);

export const THEME_IDS = new Set(THEME_OPTIONS.map((item) => item.id));

export const DEFAULT_THEME_ID = "cloud-night";

export function resolveTheme(id: string): AppTheme {
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
}

export function isThemeId(id: string | null | undefined): boolean {
  return !!id && THEME_IDS.has(id);
}

/** 经典主题与「跟随系统」都已下线：任何旧 id 都回落到默认主题 */
export function legacyThemeToId(
  themeRaw: string | null | undefined,
  _schemeRaw: string | null | undefined
): string {
  if (isThemeId(themeRaw)) return themeRaw as string;
  return DEFAULT_THEME_ID;
}

export function themeSwatches(theme: AppTheme): string[] {
  const app = theme.app;
  return [app.bgApp, app.bgPanel, app.accent, app.fg, app.ok, app.err];
}

export function familyOf(themeId: string): ThemeFamily | undefined {
  const theme = resolveTheme(themeId);
  return THEME_FAMILIES.find((family) => family.id === theme.family);
}

export function shapeOf(theme: AppTheme): ThemeShape {
  return SHAPES[theme.shape ?? "round"];
}

export function themeArtwork(theme: AppTheme): ThemeArtwork | undefined {
  return theme.artwork;
}

/**
 * 每套主题的浓度覆盖。
 *
 * 用户可以为每个主题单独记住背景插画浓度与面板浓度，
 * 切换主题时互不影响；未覆盖的项沿用主题自带值。
 */
export interface ThemeOpacity {
  /** 背景插画浓度 */
  artwork?: number;
  /** 面板材质浓度 */
  panel?: number;
}

/** 覆盖表的键：族 + 深浅，同一族的深浅主题各自独立 */
export function themeOpacityKey(theme: AppTheme): string {
  return `${theme.family ?? "starry-book"}:${theme.mode}`;
}

/** 解析覆盖表；脏数据一律丢弃，不影响主题本身 */
export function parseThemeOpacity(raw: string): Record<string, ThemeOpacity> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, ThemeOpacity> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const artwork =
        typeof entry.artwork === "number" &&
        Number.isFinite(entry.artwork) &&
        entry.artwork >= 0 &&
        entry.artwork <= 1
          ? Math.round(entry.artwork * 100) / 100
          : undefined;
      const panel =
        typeof entry.panel === "number" &&
        Number.isFinite(entry.panel) &&
        entry.panel >= 0 &&
        entry.panel <= 1
          ? Math.round(entry.panel * 100) / 100
          : undefined;
      if (artwork === undefined && panel === undefined) continue;
      result[key] = { artwork, panel };
    }
    return result;
  } catch {
    return {};
  }
}
