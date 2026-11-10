/**
 * 统一主题表。
 *
 * 每套主题同时定义：
 * - 应用界面色板（背景、面板、文字、边框、强调色等 CSS token）
 * - xterm 的完整终端配色（含 16 个 ANSI 色）
 *
 * 这样应用界面和终端来自同一套色板，不会出现两套互相独立的配色。
 */
import type { ITheme } from "@xterm/xterm";

export type ThemeMode = "dark" | "light";

/** 应用界面色板（会写入 :root 的 CSS 变量） */
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
}

// ---------- 默认深色 / 默认浅色 ----------

const DARK_TERMINAL: ITheme = {
  background: "#0B0D11",
  foreground: "#C9D1DE",
  cursor: "#7C8CFF",
  cursorAccent: "#0B0D11",
  selectionBackground: "rgba(124,140,255,.28)",
  black: "#262C37",
  red: "#FF7B72",
  green: "#7EE787",
  yellow: "#F2CC60",
  blue: "#79B8FF",
  magenta: "#D2A8FF",
  cyan: "#56D4DD",
  white: "#C9D1DE",
  brightBlack: "#626B7C",
  brightRed: "#FF9B94",
  brightGreen: "#9BF0A0",
  brightYellow: "#FFD98A",
  brightBlue: "#A5CBFF",
  brightMagenta: "#E2C4FF",
  brightCyan: "#86E6EC",
  brightWhite: "#E6E9F0",
};

const LIGHT_TERMINAL: ITheme = {
  background: "#FBFCFE",
  foreground: "#2B3240",
  cursor: "#4F5BE8",
  cursorAccent: "#FBFCFE",
  selectionBackground: "rgba(79,91,232,.20)",
  black: "#121722",
  red: "#C0392F",
  green: "#16825A",
  yellow: "#9A6512",
  blue: "#2563C9",
  magenta: "#6D3FC4",
  cyan: "#0E7C8A",
  white: "#2B3240",
  brightBlack: "#59616F",
  brightRed: "#D93A3F",
  brightGreen: "#0E9F6E",
  brightYellow: "#B7791F",
  brightBlue: "#2563C9",
  brightMagenta: "#7C4FD4",
  brightCyan: "#0F7FA8",
  brightWhite: "#121722",
};

// ---------- 主题定义 ----------

const DARK: AppTheme = {
  id: "dark",
  name: "默认深色",
  mode: "dark",
  app: {
    bgApp: "#0B0D11",
    bgPanel: "#101319",
    bgSurface: "#161A21",
    bgRaised: "#1D222B",
    bgHover: "#1F2530",
    bgActive: "#262D38",
    bgSunken: "#08090C",
    lineFaint: "#1A1F27",
    line: "#262C37",
    lineStrong: "#343C4A",
    fg: "#E6E9F0",
    fgMuted: "#98A1B2",
    fgFaint: "#626B7C",
    fgOnAccent: "#0B0D11",
    accent: "#7C8CFF",
    accentHover: "#97A4FF",
    accentPress: "#6273F5",
    ok: "#35D6A4",
    warn: "#F0B429",
    err: "#F2555A",
    info: "#46B8E0",
  },
  terminal: DARK_TERMINAL,
};

const LIGHT: AppTheme = {
  id: "light",
  name: "默认浅色",
  mode: "light",
  app: {
    bgApp: "#FBFCFE",
    bgPanel: "#F4F6FA",
    bgSurface: "#FFFFFF",
    bgRaised: "#FFFFFF",
    bgHover: "#EDF0F6",
    bgActive: "#E3E8F0",
    bgSunken: "#F7F9FC",
    lineFaint: "#E9ECF2",
    line: "#DCE1EA",
    lineStrong: "#C3CBD8",
    fg: "#121722",
    fgMuted: "#59616F",
    fgFaint: "#8B93A1",
    fgOnAccent: "#FFFFFF",
    accent: "#4F5BE8",
    accentHover: "#3E49D4",
    accentPress: "#3641C4",
    ok: "#0E9F6E",
    warn: "#B7791F",
    err: "#D93A3F",
    info: "#0F7FA8",
  },
  terminal: LIGHT_TERMINAL,
};

const DRACULA: AppTheme = {
  id: "dracula",
  name: "Dracula",
  mode: "dark",
  app: {
    bgApp: "#282A36",
    bgPanel: "#21222C",
    bgSurface: "#343746",
    bgRaised: "#383A59",
    bgHover: "#44475A",
    bgActive: "#4B4E68",
    bgSunken: "#1D1E26",
    lineFaint: "#2C2F3E",
    line: "#44475A",
    lineStrong: "#5A5E76",
    fg: "#F8F8F2",
    fgMuted: "#B9BCD0",
    fgFaint: "#7B7F96",
    fgOnAccent: "#21222C",
    accent: "#BD93F9",
    accentHover: "#CBA9FA",
    accentPress: "#A97DEB",
    ok: "#50FA7B",
    warn: "#F1FA8C",
    err: "#FF5555",
    info: "#8BE9FD",
  },
  terminal: {
    background: "#282A36",
    foreground: "#F8F8F2",
    cursor: "#F8F8F2",
    cursorAccent: "#282A36",
    selectionBackground: "#44475A",
    black: "#21222C",
    red: "#FF5555",
    green: "#50FA7B",
    yellow: "#F1FA8C",
    blue: "#BD93F9",
    magenta: "#FF79C6",
    cyan: "#8BE9FD",
    white: "#F8F8F2",
    brightBlack: "#6272A4",
    brightRed: "#FF6E6E",
    brightGreen: "#69FF94",
    brightYellow: "#FFFFA5",
    brightBlue: "#D6ACFF",
    brightMagenta: "#FF92DF",
    brightCyan: "#A4FFFF",
    brightWhite: "#FFFFFF",
  },
};

const NORD: AppTheme = {
  id: "nord",
  name: "Nord",
  mode: "dark",
  app: {
    bgApp: "#2E3440",
    bgPanel: "#292E39",
    bgSurface: "#3B4252",
    bgRaised: "#434C5E",
    bgHover: "#4C566A",
    bgActive: "#565F73",
    bgSunken: "#242933",
    lineFaint: "#343B48",
    line: "#4C566A",
    lineStrong: "#5E6A82",
    fg: "#ECEFF4",
    fgMuted: "#B4BFCE",
    fgFaint: "#7B889B",
    fgOnAccent: "#2E3440",
    accent: "#88C0D0",
    accentHover: "#9DCFDC",
    accentPress: "#74ACBC",
    ok: "#A3BE8C",
    warn: "#EBCB8B",
    err: "#BF616A",
    info: "#81A1C1",
  },
  terminal: {
    background: "#2E3440",
    foreground: "#D8DEE9",
    cursor: "#D8DEE9",
    cursorAccent: "#2E3440",
    selectionBackground: "#434C5E",
    black: "#3B4252",
    red: "#BF616A",
    green: "#A3BE8C",
    yellow: "#EBCB8B",
    blue: "#81A1C1",
    magenta: "#B48EAD",
    cyan: "#88C0D0",
    white: "#E5E9F0",
    brightBlack: "#4C566A",
    brightRed: "#D08770",
    brightGreen: "#A3BE8C",
    brightYellow: "#EBCB8B",
    brightBlue: "#8FBCBB",
    brightMagenta: "#B48EAD",
    brightCyan: "#8FBCBB",
    brightWhite: "#ECEFF4",
  },
};

const SOLARIZED_DARK: AppTheme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  mode: "dark",
  app: {
    bgApp: "#002B36",
    bgPanel: "#00252E",
    bgSurface: "#073642",
    bgRaised: "#0A4150",
    bgHover: "#0E4A5A",
    bgActive: "#125364",
    bgSunken: "#001F28",
    lineFaint: "#06323E",
    line: "#0E4A5A",
    lineStrong: "#176075",
    fg: "#93A1A1",
    fgMuted: "#839496",
    fgFaint: "#5F7375",
    fgOnAccent: "#002B36",
    accent: "#268BD2",
    accentHover: "#3FA0E6",
    accentPress: "#1D78B8",
    ok: "#859900",
    warn: "#B58900",
    err: "#DC322F",
    info: "#2AA198",
  },
  terminal: {
    background: "#002B36",
    foreground: "#839496",
    cursor: "#93A1A1",
    cursorAccent: "#002B36",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#DC322F",
    green: "#859900",
    yellow: "#B58900",
    blue: "#268BD2",
    magenta: "#D33682",
    cyan: "#2AA198",
    white: "#EEE8D5",
    brightBlack: "#586E75",
    brightRed: "#CB4B16",
    brightGreen: "#657B83",
    brightYellow: "#839496",
    brightBlue: "#839496",
    brightMagenta: "#6C71C4",
    brightCyan: "#93A1A1",
    brightWhite: "#FDF6E3",
  },
};

const SOLARIZED_LIGHT: AppTheme = {
  id: "solarized-light",
  name: "Solarized Light",
  mode: "light",
  app: {
    bgApp: "#FDF6E3",
    bgPanel: "#F5EFDC",
    bgSurface: "#EEE8D5",
    bgRaised: "#FFFBF0",
    bgHover: "#E6DFC8",
    bgActive: "#DDD6BF",
    bgSunken: "#F9F3E1",
    lineFaint: "#EFE8D4",
    line: "#D9D2C0",
    lineStrong: "#C4BCA8",
    fg: "#073642",
    fgMuted: "#586E75",
    fgFaint: "#7C8F8F",
    fgOnAccent: "#FFFFFF",
    accent: "#268BD2",
    accentHover: "#1F76B4",
    accentPress: "#196196",
    ok: "#6E7D00",
    warn: "#A57800",
    err: "#C1291F",
    info: "#157C74",
  },
  terminal: {
    background: "#FDF6E3",
    foreground: "#657B83",
    cursor: "#586E75",
    cursorAccent: "#FDF6E3",
    selectionBackground: "#EEE8D5",
    black: "#073642",
    red: "#DC322F",
    green: "#859900",
    yellow: "#B58900",
    blue: "#268BD2",
    magenta: "#D33682",
    cyan: "#2AA198",
    white: "#EEE8D5",
    brightBlack: "#586E75",
    brightRed: "#C1291F",
    brightGreen: "#5C6F00",
    brightYellow: "#8A6A00",
    brightBlue: "#1F76B4",
    brightMagenta: "#B3287A",
    brightCyan: "#187B78",
    brightWhite: "#073642",
  },
};

const GRUVBOX_DARK: AppTheme = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  mode: "dark",
  app: {
    bgApp: "#282828",
    bgPanel: "#1D2021",
    bgSurface: "#32302F",
    bgRaised: "#3C3836",
    bgHover: "#504945",
    bgActive: "#5A524C",
    bgSunken: "#1B1B1B",
    lineFaint: "#3A3736",
    line: "#504945",
    lineStrong: "#665C54",
    fg: "#EBDBB2",
    fgMuted: "#BDAE93",
    fgFaint: "#928374",
    fgOnAccent: "#282828",
    accent: "#D79921",
    accentHover: "#E5A92F",
    accentPress: "#B97F1A",
    ok: "#B8BB26",
    warn: "#FABD2F",
    err: "#FB4934",
    info: "#83A598",
  },
  terminal: {
    background: "#282828",
    foreground: "#EBDBB2",
    cursor: "#EBDBB2",
    cursorAccent: "#282828",
    selectionBackground: "#504945",
    black: "#282828",
    red: "#CC241D",
    green: "#98971A",
    yellow: "#D79921",
    blue: "#458588",
    magenta: "#B16286",
    cyan: "#689D6A",
    white: "#A89984",
    brightBlack: "#928374",
    brightRed: "#FB4934",
    brightGreen: "#B8BB26",
    brightYellow: "#FABD2F",
    brightBlue: "#83A598",
    brightMagenta: "#D3869B",
    brightCyan: "#8EC07C",
    brightWhite: "#EBDBB2",
  },
};

const TOKYO_NIGHT: AppTheme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  mode: "dark",
  app: {
    bgApp: "#1A1B26",
    bgPanel: "#16161E",
    bgSurface: "#1F2335",
    bgRaised: "#24283B",
    bgHover: "#2A2F45",
    bgActive: "#323857",
    bgSunken: "#13141C",
    lineFaint: "#232537",
    line: "#2F3549",
    lineStrong: "#414868",
    fg: "#C0CAF5",
    fgMuted: "#9AA5CE",
    fgFaint: "#6B7394",
    fgOnAccent: "#16161E",
    accent: "#7AA2F7",
    accentHover: "#92B4FA",
    accentPress: "#5F8BE6",
    ok: "#9ECE6A",
    warn: "#E0AF68",
    err: "#F7768E",
    info: "#7DCFFF",
  },
  terminal: {
    background: "#1A1B26",
    foreground: "#C0CAF5",
    cursor: "#C0CAF5",
    cursorAccent: "#1A1B26",
    selectionBackground: "#2F3549",
    black: "#414868",
    red: "#F7768E",
    green: "#9ECE6A",
    yellow: "#E0AF68",
    blue: "#7AA2F7",
    magenta: "#BB9AF7",
    cyan: "#7DCFFF",
    white: "#A9B1D6",
    brightBlack: "#565F89",
    brightRed: "#FF7A93",
    brightGreen: "#B9F27C",
    brightYellow: "#FF9E64",
    brightBlue: "#7DA6FF",
    brightMagenta: "#C7A9FF",
    brightCyan: "#A4DAFF",
    brightWhite: "#C0CAF5",
  },
};

const ONE_DARK: AppTheme = {
  id: "one-dark",
  name: "One Dark",
  mode: "dark",
  app: {
    bgApp: "#282C34",
    bgPanel: "#21252B",
    bgSurface: "#2C313A",
    bgRaised: "#333842",
    bgHover: "#3A404C",
    bgActive: "#424855",
    bgSunken: "#1E2127",
    lineFaint: "#30353E",
    line: "#3E4451",
    lineStrong: "#4F5666",
    fg: "#ABB2BF",
    fgMuted: "#878E9B",
    fgFaint: "#5C6370",
    fgOnAccent: "#21252B",
    accent: "#61AFEF",
    accentHover: "#7CBEFF",
    accentPress: "#4F9CD9",
    ok: "#98C379",
    warn: "#E5C07B",
    err: "#E06C75",
    info: "#56B6C2",
  },
  terminal: {
    background: "#282C34",
    foreground: "#ABB2BF",
    cursor: "#528BFF",
    cursorAccent: "#282C34",
    selectionBackground: "#3E4451",
    black: "#282C34",
    red: "#E06C75",
    green: "#98C379",
    yellow: "#E5C07B",
    blue: "#61AFEF",
    magenta: "#C678DD",
    cyan: "#56B6C2",
    white: "#ABB2BF",
    brightBlack: "#5C6370",
    brightRed: "#E06C75",
    brightGreen: "#98C379",
    brightYellow: "#E5C07B",
    brightBlue: "#61AFEF",
    brightMagenta: "#C678DD",
    brightCyan: "#56B6C2",
    brightWhite: "#FFFFFF",
  },
};

const CATPPUCCIN_MOCHA: AppTheme = {
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  mode: "dark",
  app: {
    bgApp: "#1E1E2E",
    bgPanel: "#181825",
    bgSurface: "#313244",
    bgRaised: "#313244",
    bgHover: "#45475A",
    bgActive: "#4E5168",
    bgSunken: "#11111B",
    lineFaint: "#2A2A3C",
    line: "#45475A",
    lineStrong: "#585B70",
    fg: "#CDD6F4",
    fgMuted: "#A6ADC8",
    fgFaint: "#6C7086",
    fgOnAccent: "#11111B",
    accent: "#CBA6F7",
    accentHover: "#D8B9FF",
    accentPress: "#B48BE0",
    ok: "#A6E3A1",
    warn: "#F9E2AF",
    err: "#F38BA8",
    info: "#89DCEB",
  },
  terminal: {
    background: "#1E1E2E",
    foreground: "#CDD6F4",
    cursor: "#F5E0DC",
    cursorAccent: "#1E1E2E",
    selectionBackground: "#45475A",
    black: "#45475A",
    red: "#F38BA8",
    green: "#A6E3A1",
    yellow: "#F9E2AF",
    blue: "#89B4FA",
    magenta: "#F5C2E7",
    cyan: "#89DCEB",
    white: "#BAC2DE",
    brightBlack: "#585B70",
    brightRed: "#F38BA8",
    brightGreen: "#A6E3A1",
    brightYellow: "#F9E2AF",
    brightBlue: "#89B4FA",
    brightMagenta: "#F5C2E7",
    brightCyan: "#94E2D5",
    brightWhite: "#A6ADC8",
  },
};

const THEMES: Record<string, AppTheme> = {
  dark: DARK,
  light: LIGHT,
  dracula: DRACULA,
  nord: NORD,
  "solarized-dark": SOLARIZED_DARK,
  "solarized-light": SOLARIZED_LIGHT,
  "gruvbox-dark": GRUVBOX_DARK,
  "tokyo-night": TOKYO_NIGHT,
  "one-dark": ONE_DARK,
  "catppuccin-mocha": CATPPUCCIN_MOCHA,
};

export const THEME_OPTIONS: { id: string; name: string }[] = [
  { id: "dark", name: DARK.name },
  { id: "light", name: LIGHT.name },
  { id: "system", name: "跟随系统" },
  { id: "dracula", name: DRACULA.name },
  { id: "nord", name: NORD.name },
  { id: "solarized-dark", name: SOLARIZED_DARK.name },
  { id: "solarized-light", name: SOLARIZED_LIGHT.name },
  { id: "gruvbox-dark", name: GRUVBOX_DARK.name },
  { id: "tokyo-night", name: TOKYO_NIGHT.name },
  { id: "one-dark", name: ONE_DARK.name },
  { id: "catppuccin-mocha", name: CATPPUCCIN_MOCHA.name },
];

export const THEME_IDS = new Set(THEME_OPTIONS.map((item) => item.id));

export const DEFAULT_THEME_ID = "dark";

function prefersLight(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

/**
 * 解析主题 id。
 * 「跟随系统」会按系统深浅色在默认深色 / 默认浅色之间切换。
 */
export function resolveTheme(id: string): AppTheme {
  if (id === "system") {
    const base = prefersLight() ? LIGHT : DARK;
    return { ...base, id: "system", name: "跟随系统" };
  }
  return THEMES[id] ?? DARK;
}

export function isThemeId(id: string | null | undefined): boolean {
  return !!id && THEME_IDS.has(id);
}

/**
 * 旧值迁移：
 * - 旧的 `theme` 是 dark / light / system，本身就是新的主题 id；
 * - 旧的 `term.colorScheme` 若选了具体方案，优先映射成同名的统一主题；
 * - `term.colorScheme = "app"` 表示跟随旧主题，忽略即可。
 */
export function legacyThemeToId(
  themeRaw: string | null | undefined,
  schemeRaw: string | null | undefined
): string {
  if (
    schemeRaw &&
    schemeRaw !== "app" &&
    THEME_IDS.has(schemeRaw) &&
    schemeRaw !== "system"
  ) {
    return schemeRaw;
  }
  if (isThemeId(themeRaw)) return themeRaw as string;
  return DEFAULT_THEME_ID;
}

/** 主题卡片的小色板预览：背景、面板、强调、前景、成功、错误 */
export function themeSwatches(theme: AppTheme): string[] {
  const app = theme.app;
  return [app.bgApp, app.bgPanel, app.accent, app.fg, app.ok, app.err];
}
