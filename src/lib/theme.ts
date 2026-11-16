/**
 * 主题应用。
 *
 * 主题 id 唯一决定整套外观：既写入应用界面的 CSS 变量，
 * 也提供终端使用的 xterm 配色（见 app-themes.ts）。
 *
 * 持久化不在这里做 —— 统一交给 settings.ts 的注册表。
 */
import { resolveTheme, type AppTheme } from "./app-themes";

const EVENT_NAME = "lshell:themechange";

/**
 * 面板表面在背景图上的透明度。
 *
 * 侧栏、标签栏、文件面板、状态栏、终端容器都用它，
 * 只由主题色决定颜色，避免各处各自调一套半透明值。
 */
const VEIL_ALPHA = 0.8;

function channel(hex: string, index: number): number {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return 255;
  return parseInt(clean.slice(index * 2, index * 2 + 2), 16);
}

/** 把 #RRGGBB 转成带透明度的 rgba() */
function rgba(hex: string, alpha: number): string {
  return `rgba(${channel(hex, 0)}, ${channel(hex, 1)}, ${channel(hex, 2)}, ${alpha})`;
}

/** 应用一套主题：写入 CSS 变量、切换深浅标记、广播变更 */
export function applyTheme(themeId: string): AppTheme {
  const theme = resolveTheme(themeId);

  const root = document.documentElement;
  const p = theme.app;
  const t = theme.terminal;
  const set = (name: string, value: string) => root.style.setProperty(name, value);

  // 深浅标记：tokens.css 里的 light 专属规则（输入框底色、阴影）仍据此生效
  root.dataset.theme = theme.mode;

  // 应用界面色板
  set("--bg-app", p.bgApp);
  set("--bg-panel", p.bgPanel);
  set("--bg-surface", p.bgSurface);
  set("--bg-raised", p.bgRaised);
  set("--bg-hover", p.bgHover);
  set("--bg-active", p.bgActive);
  set("--bg-sunken", p.bgSunken);

  set("--line-faint", p.lineFaint);
  set("--line", p.line);
  set("--line-strong", p.lineStrong);

  set("--fg", p.fg);
  set("--fg-muted", p.fgMuted);
  set("--fg-faint", p.fgFaint);
  set("--fg-on-accent", p.fgOnAccent);

  set("--accent", p.accent);
  set("--accent-hover", p.accentHover);
  set("--accent-press", p.accentPress);
  set("--accent-dim", rgba(p.accent, 0.14));
  set("--accent-line", rgba(p.accent, 0.34));
  set("--accent-glow", rgba(p.accent, 0.42));

  set("--ok", p.ok);
  set("--ok-dim", rgba(p.ok, 0.14));
  set("--warn", p.warn);
  set("--warn-dim", rgba(p.warn, 0.14));
  set("--err", p.err);
  set("--err-dim", rgba(p.err, 0.14));
  set("--info", p.info);
  set("--info-dim", rgba(p.info, 0.14));

  // 半透明表面：铺背景图时用，保证面板文字可读。
  // 终端容器不再单独一套：和侧栏/标签栏/状态栏共用同一块「面板材质」，
  // 颜色与透明度都来自 --bg-panel / --bg-panel-veil。
  set("--bg-panel-veil", rgba(p.bgPanel, VEIL_ALPHA));
  set("--bg-surface-veil", rgba(p.bgSurface, VEIL_ALPHA));

  // 滚动条
  set("--scroll-thumb", p.lineStrong);
  set("--scroll-thumb-hover", p.line);

  // 终端配色（部分组件/空状态仍会用到这些变量）
  set("--term-bg", t.background ?? p.bgApp);
  set("--term-fg", t.foreground ?? p.fg);
  set("--term-cursor", t.cursor ?? p.accent);
  set("--term-sel", t.selectionBackground ?? rgba(p.accent, 0.28));
  set("--term-black", t.black ?? p.bgSunken);
  set("--term-red", t.red ?? p.err);
  set("--term-green", t.green ?? p.ok);
  set("--term-yellow", t.yellow ?? p.warn);
  set("--term-blue", t.blue ?? p.accent);
  set("--term-magenta", t.magenta ?? p.accent);
  set("--term-cyan", t.cyan ?? p.info);
  set("--term-white", t.white ?? p.fg);
  set("--term-bright-black", t.brightBlack ?? p.fgFaint);
  set("--term-bright-red", t.brightRed ?? p.err);
  set("--term-bright-green", t.brightGreen ?? p.ok);
  set("--term-bright-yellow", t.brightYellow ?? p.warn);
  set("--term-bright-blue", t.brightBlue ?? p.accent);
  set("--term-bright-magenta", t.brightMagenta ?? p.accent);
  set("--term-bright-cyan", t.brightCyan ?? p.info);
  set("--term-bright-white", t.brightWhite ?? p.fg);

  window.dispatchEvent(
    new CustomEvent<{ theme: AppTheme }>(EVENT_NAME, { detail: { theme } })
  );
  return theme;
}

/** 订阅主题变更（含「跟随系统」时系统深浅色切换），返回取消订阅函数 */
export function onThemeChange(handler: (theme: AppTheme) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ theme: AppTheme }>).detail;
    handler(detail.theme);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
