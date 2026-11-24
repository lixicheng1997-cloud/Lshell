/**
 * 主题应用。
 *
 * 主题 id 唯一决定整套外观：既写入应用界面的 CSS 变量，
 * 也提供终端使用的 xterm 配色（见 app-themes.ts）。
 *
 * 持久化不在这里做 —— 统一交给 settings.ts 的注册表。
 */
import { resolveTheme, shapeOf, type AppTheme } from "./app-themes";
import { uiFontStack } from "./fonts";

const EVENT_NAME = "lshell:themechange";

function channel(hex: string, index: number): number {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return 255;
  return parseInt(clean.slice(index * 2, index * 2 + 2), 16);
}

/** 把 #RRGGBB 转成带透明度的 rgba() */
function rgba(hex: string, alpha: number): string {
  return `rgba(${channel(hex, 0)}, ${channel(hex, 1)}, ${channel(hex, 2)}, ${alpha})`;
}

/**
 * 应用一套主题：写入 CSS 变量、切换深浅标记、广播变更
 *
 * @param themeId 主题 id
 * @param uiFont 用户手动指定的界面字体；不传则用主题推荐字体
 * @param panelOpacity 面板不透明度；不传则用主题形态自带值
 */
export function applyTheme(
  themeId: string,
  uiFont?: string,
  panelOpacity?: number
): AppTheme {
  const theme = resolveTheme(themeId);

  const root = document.documentElement;
  const p = theme.app;
  const t = theme.terminal;
  const shape = shapeOf(theme);
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  // 面板浓度：用户自定义优先，否则用主题形态的值
  const veil = panelOpacity ?? shape.veil;

  // 深浅 / 族 / 形态标记：tokens.css 的 light 规则与 theme-variants.css 据此生效
  root.dataset.theme = theme.mode;
  root.dataset.themeFamily = theme.family ?? "default";
  root.dataset.themeShape = shape.id;

  // 形态层：圆角、胶囊、动效、排版密度与面板材质
  set("--r-sm", shape.radius[0]);
  set("--r-md", shape.radius[1]);
  set("--r-lg", shape.radius[2]);
  set("--r-xl", shape.radius[3]);
  set("--r-pill", shape.pill);
  set("--veil-panel", String(veil));
  set("--dur", shape.duration);
  set("--ease", shape.ease);
  set("--ls-label", shape.labelSpacing);
  set("--fw-label", String(shape.labelWeight));

  // 字体：用户手动选择优先，否则用主题推荐字体，最后回落系统默认
  set("--font-ui", uiFont ? uiFontStack(uiFont) : theme.fonts?.ui ?? uiFontStack("system"));

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

  // 半透明表面：铺背景图时用。面板透明度由主题形态决定；
  // 终端容器单独用更高的不透明度，保证代码在插画上仍然可读。
  set("--bg-panel-veil", rgba(p.bgPanel, veil));
  set("--bg-surface-veil", rgba(p.bgSurface, veil));

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

/** 订阅主题变更，返回取消订阅函数 */
export function onThemeChange(handler: (theme: AppTheme) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ theme: AppTheme }>).detail;
    handler(detail.theme);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
