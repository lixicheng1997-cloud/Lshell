import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** 弹层内可聚焦的元素（排除 tabindex=-1 与禁用控件） */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * 自绘弹层的最小可访问性支持。
 *
 * - 打开时把焦点移进弹层（已有 autoFocus 元素时尊重它）
 * - Tab / Shift+Tab 在弹层内循环，不会跑到背景控件上
 * - 关闭后把焦点还给打开它的元素
 *
 * 用法：把返回的 `ref` 挂到 `.dialog` 上，并展开 `dialogProps`。
 */
export function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  /** 打开弹层前的焦点元素，关闭后归还 */
  const previousRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const dialog = ref.current;
    // 弹层里已经有焦点（例如按钮上的 autoFocus）就不再抢
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.focus();
    }

    return () => {
      const previous = previousRef.current;
      // 触发元素可能已被卸载，focus 前确认仍在文档里
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    const dialog = ref.current;
    if (!dialog) return;

    const items = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
    ).filter((el) => el.offsetParent !== null);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return {
    ref,
    dialogProps: {
      role: "dialog" as const,
      "aria-modal": true,
      tabIndex: -1,
      onKeyDown,
    },
  };
}
