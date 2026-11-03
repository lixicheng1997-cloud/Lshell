/**
 * 主题管理。
 *
 * 三态：深色 / 浅色 / 跟随系统。
 * 主题写入 <html data-theme="...">，CSS 变量随之切换；
 * 同时广播 "lshell:themechange" 事件，让 xterm 同步配色。
 */
import { api } from "./api";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "lshell.theme";
const EVENT_NAME = "lshell:themechange";

/** 读取当前生效的主题（已解析的深/浅） */
export function resolvedTheme(): ResolvedTheme {
  const mode = readStoredMode();
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return mode;
}

/** 读取用户选择的模式 */
export function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    // localStorage 不可用时退回默认
  }
  return "dark";
}

/** 把主题应用到 DOM 并广播变更 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved: ResolvedTheme =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;

  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 忽略持久化失败
  }

  window.dispatchEvent(
    new CustomEvent(EVENT_NAME, { detail: { mode, resolved } })
  );
  return resolved;
}

/** 初始化：优先读数据库设置，回退到 localStorage */
export async function initTheme(): Promise<ThemeMode> {
  let mode = readStoredMode();
  try {
    const saved = await api.getSetting("theme");
    if (saved === "dark" || saved === "light" || saved === "system") {
      mode = saved;
    }
  } catch {
    // 数据库读不到就用 localStorage
  }
  applyTheme(mode);

  // 跟随系统时，系统主题变化要实时响应
  window.matchMedia("(prefers-color-scheme: light)").addEventListener(
    "change",
    () => {
      if (readStoredMode() === "system") applyTheme("system");
    }
  );

  return mode;
}

/** 切换主题并持久化 */
export async function setTheme(mode: ThemeMode): Promise<void> {
  applyTheme(mode);
  try {
    await api.setSetting("theme", mode);
  } catch {
    // 持久化失败不影响本次生效
  }
}

/** 订阅主题变更，返回取消订阅函数 */
export function onThemeChange(
  handler: (resolved: ResolvedTheme) => void
): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ resolved: ResolvedTheme }>).detail;
    handler(detail.resolved);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
