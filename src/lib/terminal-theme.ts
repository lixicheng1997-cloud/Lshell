/**
 * 终端配色桥接。
 *
 * xterm 的 theme 对象需要具体颜色值，不能直接用 CSS 变量，
 * 所以这里从计算样式里读取 tokens.css 定义的终端色变量，
 * 保证终端配色与界面配色来自同一套 token，不会各自漂移。
 */
import type { ITheme } from "@xterm/xterm";

/** 从 CSS 变量读取终端配色 */
export function readTerminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const val = s.getPropertyValue(name).trim();
    return val || fallback;
  };

  return {
    background: v("--term-bg", "#0B0D11"),
    foreground: v("--term-fg", "#C9D1DE"),
    cursor: v("--term-cursor", "#7C8CFF"),
    cursorAccent: v("--term-bg", "#0B0D11"),
    selectionBackground: v("--term-sel", "rgba(124,140,255,.28)"),

    black: v("--term-black", "#262C37"),
    red: v("--term-red", "#FF7B72"),
    green: v("--term-green", "#7EE787"),
    yellow: v("--term-yellow", "#F2CC60"),
    blue: v("--term-blue", "#79B8FF"),
    magenta: v("--term-magenta", "#D2A8FF"),
    cyan: v("--term-cyan", "#56D4DD"),
    white: v("--term-white", "#C9D1DE"),

    brightBlack: v("--term-bright-black", "#626B7C"),
    brightRed: v("--term-bright-red", "#FF9B94"),
    brightGreen: v("--term-bright-green", "#9BF0A0"),
    brightYellow: v("--term-bright-yellow", "#FFD98A"),
    brightBlue: v("--term-bright-blue", "#A5CBFF"),
    brightMagenta: v("--term-bright-magenta", "#E2C4FF"),
    brightCyan: v("--term-bright-cyan", "#86E6EC"),
    brightWhite: v("--term-bright-white", "#E6E9F0"),
  };
}
