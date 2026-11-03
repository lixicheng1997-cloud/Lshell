import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";
import type { IconName } from "./Icon";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** 快捷键提示 */
  shortcut?: string;
  disabled?: boolean;
  /** 危险操作（删除、断开）用红色 */
  danger?: boolean;
  onSelect: () => void;
}

interface Props {
  /** 菜单位置（视口坐标） */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** 菜单项高度（用于估算菜单总高，做边界翻转判断） */
const MENU_ITEM_HEIGHT = 28;
const MENU_PADDING = 6;

/**
 * 终端右键菜单。
 *
 * 自绘菜单而不是用系统原生菜单 —— 原生菜单无法定制样式，
 * 也无法在 Tauri 的 webview 里稳定控制行为。
 *
 * 位置贴近视口边缘时自动翻转，避免菜单被截断。
 */
export default function TerminalContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 挂载后按实际尺寸做一次边界校正
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x;
    let top = y;

    // 右侧放不下就翻到左边
    if (left + rect.width > vw - 8) {
      left = Math.max(8, x - rect.width);
    }
    // 下方放不下就翻到上方
    if (top + rect.height > vh - 8) {
      top = Math.max(8, vh - rect.height - 8);
    }

    setPos({ left, top });
  }, [x, y]);

  // 点击别处 / 按 Esc 关闭
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 用 capture 阶段监听，避免菜单自身的点击先被处理
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          className={`ctx-item ${item.danger ? "danger" : ""}`}
          disabled={item.disabled}
          role="menuitem"
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          <span className="ctx-label">
            {item.icon && <Icon name={item.icon} size={13} className="ctx-icon" />}
            {item.label}
          </span>
          {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}

/** 根据菜单项数量估算高度（用于调用方判断是否需要翻转） */
export function estimateMenuHeight(items: MenuItem[]): number {
  return items.length * MENU_ITEM_HEIGHT + MENU_PADDING * 2;
}
