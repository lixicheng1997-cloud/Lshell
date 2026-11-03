import { useEffect } from "react";

/**
 * 全局快捷键。
 *
 * 只在应用聚焦且没有正在输入文本时生效，避免与终端里的按键冲突。
 * 终端内部快捷键（复制粘贴等）由 xterm 自己处理。
 */
export interface Shortcut {
  /** 形如 "mod+k"、"mod+w"、"ctrl+shift+c" */
  combo: string;
  description: string;
  handler: (e: KeyboardEvent) => void;
}

interface ParsedCombo {
  key: string;
  /** mod = Ctrl（Windows）或 Cmd（macOS） */
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return {
    key,
    mod: parts.includes("mod"),
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

function matches(e: KeyboardEvent, p: ParsedCombo): boolean {
  // mod 允许 Ctrl 或 Cmd 触发
  if (p.mod) {
    if (!e.ctrlKey && !e.metaKey) return false;
  } else {
    // 未使用 mod 时，不允许带着 Ctrl/Cmd
    if (e.ctrlKey || e.metaKey) return false;
  }
  if (p.ctrl && !e.ctrlKey) return false;
  if (p.shift !== e.shiftKey) return false;
  if (p.alt !== e.altKey) return false;
  return e.key.toLowerCase() === p.key;
}

/** 焦点是否在可输入元素里 */
function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // xterm 的辅助 textarea 是内部实现细节，不代表用户在「输入框里」，
  // 因此终端获得焦点时快捷键仍应生效。
  if (target.classList.contains("xterm-helper-textarea")) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

export function useShortcuts(shortcuts: Shortcut[], enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const parsed = shortcuts.map((s) => ({ ...s, p: parseCombo(s.combo) }));

    const onKeyDown = (e: KeyboardEvent) => {
      // 在输入框里不拦截，让用户正常打字
      if (isEditing(e.target)) return;

      for (const s of parsed) {
        if (matches(e, s.p)) {
          e.preventDefault();
          s.handler(e);
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts, enabled]);
}
