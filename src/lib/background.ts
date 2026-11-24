/**
 * 背景图数据层。
 *
 * 设置里存的是应用数据目录下的绝对路径，真正渲染需要 data URL。
 * 这里做一个小容量缓存，避免切换标签 / 窗口重绘时反复走 IPC。
 */
import { api } from "./api";
import { resolveTheme, themeArtwork } from "./app-themes";
import type { Settings } from "./settings";

const MAX_CACHE = 3;
const cache = new Map<string, string>();

export async function loadBackgroundDataUrl(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached) {
    // 命中后移到队尾，保持「最近使用」的淘汰顺序
    cache.delete(path);
    cache.set(path, cached);
    return cached;
  }

  const url = await api.terminalBackgroundDataUrl(path);
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(path, url);
  return url;
}

/** 是否真的铺了背景：用户自定义图，或主题自带插画且未被关闭 */
export function hasEffectiveBackground(settings: Settings): boolean {
  if (settings.terminal.backgroundImage !== "") return true;
  return (
    settings.appearance.artworkEnabled &&
    !!themeArtwork(resolveTheme(settings.theme))
  );
}
