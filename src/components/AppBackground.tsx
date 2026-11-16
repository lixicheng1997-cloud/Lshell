import { useEffect, useState } from "react";
import { useSettings } from "../lib/settings";
import { loadBackgroundDataUrl } from "../lib/background";

/**
 * 全局背景层。
 *
 * 铺在整个应用面板底下（侧栏、标签栏、终端、状态栏），
 * 面板本身通过半透明表面变量保证文字可读。
 * 图片缺失或读取失败时静默回落成主题纯色。
 */
export default function AppBackground() {
  const { backgroundImage, backgroundOpacity, backgroundFit, backgroundBlur } =
    useSettings().terminal;
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!backgroundImage) {
      setSrc(null);
      return;
    }
    loadBackgroundDataUrl(backgroundImage)
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [backgroundImage]);

  return (
    <div className="app-bg" aria-hidden>
      {src ? (
        <div
          className="app-bg-image"
          style={{
            backgroundImage: `url("${src}")`,
            backgroundSize: backgroundFit === "tile" ? "auto" : backgroundFit,
            backgroundRepeat: backgroundFit === "tile" ? "repeat" : "no-repeat",
            opacity: backgroundOpacity,
            // 模糊时轻微放大，避免边缘出现透明缝隙
            filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
            transform: backgroundBlur > 0 ? "scale(1.05)" : undefined,
          }}
        />
      ) : null}
    </div>
  );
}
