// E:/data/Lshell/src/lib/fonts.ts
var SYSTEM = '"Segoe UI Variable Text", -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';
var CUTE_ROUND = '"ZCOOL KuaiLe", "\u7AD9\u9177\u5FEB\u4E50\u4F53", YouYuan, "\u5E7C\u5706", "Microsoft YaHei UI", sans-serif';
var CUTE_SERIF = '"ZCOOL XiaoWei", "\u7AD9\u9177\u5C0F\u8587\u4F53", STHupo, "\u534E\u6587\u7425\u73C0", "Microsoft YaHei UI", sans-serif';
var STORY = '"Smiley Sans", "\u5F97\u610F\u9ED1", YouYuan, "\u5E7C\u5706", "Microsoft YaHei UI", sans-serif';
var FRESH = '"HarmonyOS Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif';
var UI_FONT_STACKS = {
  system: SYSTEM,
  "cute-round": CUTE_ROUND,
  "cute-serif": CUTE_SERIF,
  story: STORY,
  fresh: FRESH
};

// E:/data/Lshell/src/lib/app-themes.ts
var SHAPES = {
  crisp: {
    id: "crisp",
    radius: ["6px", "9px", "14px", "18px"],
    pill: "999px",
    veil: 0.8,
    termVeil: 0.94,
    duration: "150ms",
    ease: "cubic-bezier(.4, 0, .2, 1)",
    labelSpacing: ".12em",
    labelWeight: 700
  },
  round: {
    id: "round",
    radius: ["10px", "14px", "20px", "26px"],
    pill: "999px",
    veil: 0.72,
    termVeil: 0.92,
    duration: "220ms",
    ease: "cubic-bezier(.2, .9, .3, 1.2)",
    labelSpacing: ".08em",
    labelWeight: 650
  },
  soft: {
    id: "soft",
    radius: ["8px", "12px", "18px", "22px"],
    pill: "999px",
    veil: 0.74,
    termVeil: 0.92,
    duration: "240ms",
    ease: "cubic-bezier(.3, .8, .3, 1)",
    labelSpacing: ".06em",
    labelWeight: 620
  }
};
function hexToRgb(hex) {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ];
}
function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${clamp(r1 + (r2 - r1) * t)}${clamp(g1 + (g2 - g1) * t)}${clamp(
    b1 + (b2 - b1) * t
  )}`;
}
function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
var DARK_TERMINAL = {
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
  brightWhite: "#E6E9F0"
};
var LIGHT_TERMINAL = {
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
  brightWhite: "#121722"
};
var DARK = {
  id: "dark",
  name: "\u9ED8\u8BA4\u6DF1\u8272",
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
    info: "#46B8E0"
  },
  terminal: DARK_TERMINAL
};
var LIGHT = {
  id: "light",
  name: "\u9ED8\u8BA4\u6D45\u8272",
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
    info: "#0F7FA8"
  },
  terminal: LIGHT_TERMINAL
};
var DRACULA = {
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
    info: "#8BE9FD"
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
    brightWhite: "#FFFFFF"
  }
};
var NORD = {
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
    info: "#81A1C1"
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
    brightWhite: "#ECEFF4"
  }
};
var SOLARIZED_DARK = {
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
    info: "#2AA198"
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
    brightWhite: "#FDF6E3"
  }
};
var SOLARIZED_LIGHT = {
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
    info: "#157C74"
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
    brightWhite: "#073642"
  }
};
var GRUVBOX_DARK = {
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
    info: "#83A598"
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
    brightWhite: "#EBDBB2"
  }
};
var TOKYO_NIGHT = {
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
    info: "#7DCFFF"
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
    brightWhite: "#C0CAF5"
  }
};
var ONE_DARK = {
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
    info: "#56B6C2"
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
    brightWhite: "#FFFFFF"
  }
};
var CATPPUCCIN_MOCHA = {
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
    info: "#89DCEB"
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
    brightWhite: "#A6ADC8"
  }
};
function makeTheme(id, name, mode, seed) {
  const dark = mode === "dark";
  const app = {
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
    info: seed.info
  };
  const magenta = seed.magenta ?? mix(seed.accent, seed.fg, 0.4);
  const bright = (color) => mix(color, dark ? "#ffffff" : "#000000", dark ? 0.2 : 0.14);
  const terminal = {
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
    brightWhite: mix(seed.fg, dark ? "#ffffff" : "#000000", 0.12)
  };
  return { id, name, mode, app, terminal, family: "", shape: "crisp" };
}
var DRACULA_LIGHT = makeTheme("dracula-light", "Dracula Light", "light", {
  bg: "#FAFAFC",
  panel: "#F0F0F6",
  surface: "#FFFFFF",
  fg: "#282A36",
  accent: "#8650B7",
  ok: "#1E8449",
  warn: "#8A6D00",
  err: "#C4262E",
  info: "#1F7C8A",
  magenta: "#B0388C"
});
var NORD_LIGHT = makeTheme("nord-light", "Nord Light", "light", {
  bg: "#F5F7FA",
  panel: "#EAEFF4",
  surface: "#FFFFFF",
  fg: "#2E3440",
  accent: "#5E88A0",
  ok: "#6B8F4E",
  warn: "#A88443",
  err: "#A85A62",
  info: "#4C7595",
  magenta: "#8C6B9B"
});
var GRUVBOX_LIGHT = makeTheme("gruvbox-light", "Gruvbox Light", "light", {
  bg: "#FBF1C7",
  panel: "#F2E5BC",
  surface: "#FFF9DB",
  fg: "#3C3836",
  accent: "#976931",
  ok: "#66800B",
  warn: "#B57614",
  err: "#B23A2B",
  info: "#427B83",
  magenta: "#9C5A7E"
});
var TOKYO_NIGHT_DAY = makeTheme("tokyo-night-day", "Tokyo Night Day", "light", {
  bg: "#E8E9F0",
  panel: "#DCDDEA",
  surface: "#FFFFFF",
  fg: "#343B58",
  accent: "#3451B2",
  ok: "#3B6E42",
  warn: "#8A5A20",
  err: "#B34B5E",
  info: "#2A7A9E",
  magenta: "#7B4BA8"
});
var ONE_LIGHT = makeTheme("one-light", "One Light", "light", {
  bg: "#F9FAFC",
  panel: "#EFF1F5",
  surface: "#FFFFFF",
  fg: "#383A42",
  accent: "#4078F2",
  ok: "#50A14F",
  warn: "#C18401",
  err: "#E45649",
  info: "#0184BC",
  magenta: "#A626A4"
});
var CATPPUCCIN_LATTE = makeTheme("catppuccin-latte", "Catppuccin Latte", "light", {
  bg: "#EFF1F5",
  panel: "#E6E9EF",
  surface: "#FFFFFF",
  fg: "#4C4F69",
  accent: "#8839EF",
  ok: "#40A02B",
  warn: "#DF8E1D",
  err: "#D20F39",
  info: "#1E66F5",
  magenta: "#EA76CB"
});
var STARRY_DARK_ART = {
  src: new URL("../assets/themes/starry-book-dark.png", import.meta.url).href,
  opacity: 0.55,
  fit: "cover",
  blur: 0
};
var CLOUD_NIGHT = makeTheme("cloud-night", "\u4E91\u6735\u68C9\u82B1\u7CD6 \xB7 \u591C\u4E91", "dark", {
  bg: "#1C1B2E",
  panel: "#26243C",
  surface: "#302E49",
  fg: "#EDE8FF",
  accent: "#B9A4FF",
  ok: "#8FE3C2",
  warn: "#FFD49A",
  err: "#FF9BA8",
  info: "#9BD8FF"
});
var CLOUD_DAY = makeTheme("cloud-day", "\u4E91\u6735\u68C9\u82B1\u7CD6 \xB7 \u65E5\u4E91", "light", {
  bg: "#F7F3FF",
  panel: "#EEE8FC",
  surface: "#FFFFFF",
  fg: "#3B3358",
  accent: "#7B61D1",
  ok: "#3E9E79",
  warn: "#B77A24",
  err: "#C94F6A",
  info: "#4A8FC7"
});
var PEACH_NIGHT = makeTheme("peach-night", "\u871C\u6843\u5976\u76D6 \xB7 \u871C\u6843\u591C", "dark", {
  bg: "#2A1F26",
  panel: "#352831",
  surface: "#42313C",
  fg: "#FFEDE8",
  accent: "#FFB39B",
  ok: "#A8DCB1",
  warn: "#FFD58A",
  err: "#FF8E8E",
  info: "#A8CBEA"
});
var PEACH_DAY = makeTheme("peach-day", "\u871C\u6843\u5976\u76D6 \xB7 \u871C\u6843\u65E5", "light", {
  bg: "#FFF8F3",
  panel: "#FBEDE5",
  surface: "#FFFFFF",
  fg: "#4A332E",
  accent: "#D96F4E",
  ok: "#4D9A6A",
  warn: "#B57B1E",
  err: "#C44B4B",
  info: "#4E86A8"
});
var STARRY_NIGHT = makeTheme("starry-night", "\u661F\u591C\u7ED8\u672C \xB7 \u661F\u591C", "dark", {
  bg: "#1B1B33",
  panel: "#23233F",
  surface: "#2E2E4C",
  fg: "#E8E6FF",
  accent: "#9C93FF",
  ok: "#83D6B0",
  warn: "#F3D38D",
  err: "#F28C99",
  info: "#8FCBE8"
});
var STARRY_DAY = makeTheme("starry-day", "\u661F\u591C\u7ED8\u672C \xB7 \u6668\u5149", "light", {
  bg: "#F7F8FF",
  panel: "#ECEEFF",
  surface: "#FFFFFF",
  fg: "#36385E",
  accent: "#6B62C9",
  ok: "#438C6A",
  warn: "#A87A21",
  err: "#C05568",
  info: "#447FA6"
});
var MINT_NIGHT = makeTheme("mint-night", "\u8584\u8377\u6C7D\u6C34 \xB7 \u6DF1\u8584\u8377", "dark", {
  bg: "#142622",
  panel: "#1C322C",
  surface: "#254037",
  fg: "#E4FFF4",
  accent: "#7EE0B8",
  ok: "#A6E86F",
  warn: "#F2CF7A",
  err: "#FF8E8E",
  info: "#7CCBD9"
});
var MINT_DAY = makeTheme("mint-day", "\u8584\u8377\u6C7D\u6C34 \xB7 \u6D45\u8584\u8377", "light", {
  bg: "#F2FBF7",
  panel: "#E6F5EE",
  surface: "#FFFFFF",
  fg: "#26453A",
  accent: "#2E9E77",
  ok: "#4E9440",
  warn: "#A8801E",
  err: "#C05050",
  info: "#3B899C"
});
var THEME_FAMILIES = [
  { id: "default", name: "\u6DF1\u7A7A\u975B\u7D2B", group: "classic", shape: "crisp", darkId: "dark", lightId: "light", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "solarized", name: "Solarized", group: "classic", shape: "crisp", darkId: "solarized-dark", lightId: "solarized-light", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "dracula", name: "Dracula", group: "classic", shape: "crisp", darkId: "dracula", lightId: "dracula-light", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "nord", name: "Nord", group: "classic", shape: "crisp", darkId: "nord", lightId: "nord-light", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "gruvbox", name: "Gruvbox", group: "classic", shape: "crisp", darkId: "gruvbox-dark", lightId: "gruvbox-light", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "tokyo-night", name: "Tokyo Night", group: "classic", shape: "crisp", darkId: "tokyo-night", lightId: "tokyo-night-day", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "one", name: "One", group: "classic", shape: "crisp", darkId: "one-dark", lightId: "one-light", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "catppuccin", name: "Catppuccin", group: "classic", shape: "crisp", darkId: "catppuccin-mocha", lightId: "catppuccin-latte", fonts: { ui: UI_FONT_STACKS.system } },
  { id: "cloud", name: "\u4E91\u6735\u68C9\u82B1\u7CD6", group: "custom", shape: "round", darkId: "cloud-night", lightId: "cloud-day", fonts: { ui: UI_FONT_STACKS["cute-round"] } },
  { id: "peach", name: "\u871C\u6843\u5976\u76D6", group: "custom", shape: "soft", darkId: "peach-night", lightId: "peach-day", fonts: { ui: UI_FONT_STACKS["cute-serif"] } },
  {
    id: "starry-book",
    name: "\u661F\u591C\u7ED8\u672C",
    group: "custom",
    shape: "round",
    darkId: "starry-night",
    lightId: "starry-day",
    fonts: { ui: UI_FONT_STACKS.story },
    artwork: { dark: STARRY_DARK_ART }
  },
  { id: "mint", name: "\u8584\u8377\u6C7D\u6C34", group: "custom", shape: "crisp", darkId: "mint-night", lightId: "mint-day", fonts: { ui: UI_FONT_STACKS.fresh } }
];
var THEMES_RAW = {
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
  "dracula-light": DRACULA_LIGHT,
  "nord-light": NORD_LIGHT,
  "gruvbox-light": GRUVBOX_LIGHT,
  "tokyo-night-day": TOKYO_NIGHT_DAY,
  "one-light": ONE_LIGHT,
  "catppuccin-latte": CATPPUCCIN_LATTE,
  "cloud-night": CLOUD_NIGHT,
  "cloud-day": CLOUD_DAY,
  "peach-night": PEACH_NIGHT,
  "peach-day": PEACH_DAY,
  "starry-night": STARRY_NIGHT,
  "starry-day": STARRY_DAY,
  "mint-night": MINT_NIGHT,
  "mint-day": MINT_DAY
};
function decorateAll(raw) {
  const result = {};
  for (const [id, theme] of Object.entries(raw)) {
    const family = THEME_FAMILIES.find(
      (item) => item.darkId === id || item.lightId === id
    );
    result[id] = {
      ...theme,
      family: family?.id ?? "default",
      shape: family?.shape ?? "crisp",
      fonts: family?.fonts ?? { ui: UI_FONT_STACKS.system },
      artwork: family?.artwork?.[theme.mode]
    };
  }
  return result;
}
var THEMES = decorateAll(THEMES_RAW);
var THEME_OPTIONS = [
  { id: "system", name: "\u8DDF\u968F\u7CFB\u7EDF", group: "special", mode: "system" },
  ...THEME_FAMILIES.flatMap((family) => {
    const dark = THEMES[family.darkId];
    const light = THEMES[family.lightId];
    return [
      { id: dark.id, name: dark.name, group: family.group, mode: "dark" },
      { id: light.id, name: light.name, group: family.group, mode: "light" }
    ];
  })
];
var THEME_IDS = new Set(THEME_OPTIONS.map((item) => item.id));
var DEFAULT_THEME_ID = "dark";
function prefersLight() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}
function resolveTheme(id) {
  if (id === "system") {
    const base = prefersLight() ? LIGHT : DARK;
    const decorated = THEMES[base.id] ?? base;
    return { ...decorated, id: "system", name: "\u8DDF\u968F\u7CFB\u7EDF" };
  }
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
}
function isThemeId(id) {
  return !!id && THEME_IDS.has(id);
}
function legacyThemeToId(themeRaw, schemeRaw) {
  if (schemeRaw && schemeRaw !== "app" && THEME_IDS.has(schemeRaw) && schemeRaw !== "system") {
    return schemeRaw;
  }
  if (isThemeId(themeRaw)) return themeRaw;
  return DEFAULT_THEME_ID;
}
function themeSwatches(theme) {
  const app = theme.app;
  return [app.bgApp, app.bgPanel, app.accent, app.fg, app.ok, app.err];
}
function familyOf(themeId) {
  const theme = resolveTheme(themeId);
  return THEME_FAMILIES.find((family) => family.id === theme.family);
}
function shapeOf(theme) {
  return SHAPES[theme.shape ?? "crisp"];
}
function themeArtwork(theme) {
  return theme.artwork;
}
export {
  DEFAULT_THEME_ID,
  SHAPES,
  THEME_FAMILIES,
  THEME_IDS,
  THEME_OPTIONS,
  familyOf,
  isThemeId,
  legacyThemeToId,
  resolveTheme,
  shapeOf,
  themeArtwork,
  themeSwatches
};
