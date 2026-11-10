/**
 * 全局图标提示。
 *
 * 任何带 `data-tip` 的元素都会在悬浮 220ms 或键盘聚焦时显示一条气泡；
 * 气泡渲染在应用根部（position: fixed），因此不会被 SFTP 列表、
 * 面板等 overflow 容器裁掉。
 *
 * 用法：给按钮加 `data-tip="中文说明"`，同时补 `aria-label` 供读屏。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Anchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface TipState {
  text: string;
  anchor: Anchor;
}

const HOVER_DELAY = 220;

export default function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | null = null;

    const findTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      return target.closest<HTMLElement>("[data-tip]");
    };

    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text) return;
      const r = el.getBoundingClientRect();
      setTip({
        text,
        anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      });
    };

    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };

    const onPointerOver = (e: PointerEvent) => {
      const el = findTarget(e.target);
      if (!el || el === current) return;
      window.clearTimeout(timer);
      current = el;
      timer = window.setTimeout(() => {
        if (current === el) show(el);
      }, HOVER_DELAY);
    };

    const onPointerOut = (e: PointerEvent) => {
      if (!current) return;
      const related = e.relatedTarget as Node | null;
      if (related && current.contains(related)) return;
      hide();
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = findTarget(e.target);
      // 只响应键盘聚焦：鼠标点击后的焦点不弹提示
      if (!el || !el.matches(":focus-visible")) return;
      window.clearTimeout(timer);
      current = el;
      show(el);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!current) return;
      const related = e.relatedTarget as Node | null;
      if (related && current.contains(related)) return;
      hide();
    };

    const opts: AddEventListenerOptions = { passive: true };
    document.addEventListener("pointerover", onPointerOver, opts);
    document.addEventListener("pointerout", onPointerOut, opts);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", onPointerOver, opts);
      document.removeEventListener("pointerout", onPointerOut, opts);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // 渲染后按气泡实际尺寸定位：默认右对齐触发元素，空间不足时翻到上方
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el || !tip) return;
    const { anchor } = tip;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(
      8,
      Math.min(anchor.right - w, window.innerWidth - w - 8)
    );
    let top = anchor.bottom + 8;
    if (top + h > window.innerHeight - 8) {
      top = Math.max(8, anchor.top - h - 8);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  }, [tip]);

  if (!tip) return null;

  return (
    <div
      ref={bubbleRef}
      className="app-tooltip"
      role="tooltip"
      style={{ visibility: "hidden" }}
    >
      {tip.text}
    </div>
  );
}
