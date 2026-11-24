import { useEffect, useState } from "react";
import { useSettings } from "../lib/settings";
import { loadBackgroundDataUrl } from "../lib/background";
import {
  parseThemeOpacity,
  resolveTheme,
  themeArtwork,
  themeOpacityKey,
} from "../lib/app-themes";

/**
 * 全局背景层。
 *
 * 优先级：用户自定义背景图 > 主题自带插画 > 主题纯色。
 * 用户图走 Rust 读本地文件，主题插画是 Vite 打包好的静态 URL，
 * 不经过 IPC，因此切换主题时是瞬间生效的。
 * 图片缺失或读取失败时静默回落成主题纯色。
 */
export default function AppBackground() {
  const settings = useSettings();
  const { backgroundImage, backgroundOpacity, backgroundFit, backgroundBlur } =
    settings.terminal;
  const { artworkEnabled } = settings.appearance;
  const resolved = resolveTheme(settings.theme);
  const artwork = artworkEnabled ? themeArtwork(resolved) : undefined;
  // 每套主题单独记住自己的插画浓度
  const opacityOverride = parseThemeOpacity(settings.appearance.themeOpacity)[
    themeOpacityKey(resolved)
  ]?.artwork;
  const useUserImage = backgroundImage !== "";
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (useUserImage) {
      loadBackgroundDataUrl(backgroundImage)
        .then((url) => {
          if (alive) setSrc(url);
        })
        .catch(() => {
          if (alive) setSrc(null);
        });
    } else {
      setSrc(artwork?.src ?? null);
    }
    return () => {
      alive = false;
    };
  }, [backgroundImage, useUserImage, artwork?.src]);

  // 主题插画用自己的参数，不受用户背景图的滑块影响；
  // 插画浓度可以「跟随主题」或由用户手动指定
  const opacity = useUserImage
    ? backgroundOpacity
    : (opacityOverride ?? artwork?.opacity ?? 1);
  const fit = useUserImage ? backgroundFit : artwork?.fit ?? "cover";
  const blur = useUserImage ? backgroundBlur : artwork?.blur ?? 0;

  return (
    <div className="app-bg" aria-hidden>
      {src ? (
        <div
          className="app-bg-image"
          style={{
            backgroundImage: `url("${src}")`,
            backgroundSize: fit === "tile" ? "auto" : fit,
            backgroundRepeat: fit === "tile" ? "repeat" : "no-repeat",
            opacity,
            // 模糊时轻微放大，避免边缘出现透明缝隙
            filter: blur > 0 ? `blur(${blur}px)` : undefined,
            transform: blur > 0 ? "scale(1.05)" : undefined,
          }}
        />
      ) : null}
    </div>
  );
}
