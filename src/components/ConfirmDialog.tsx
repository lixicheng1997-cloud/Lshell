import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../lib/dialog";
import Icon, { type IconName } from "./Icon";

interface Props {
  title: string;
  icon?: IconName;
  /** 确认内容：一般是一两句话的后果说明 */
  children: ReactNode;
  confirmText?: string;
  /** 危险操作：确认按钮用警示色 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用确认对话框。
 *
 * 与「新建主机」对话框同一套控件与排版，替代 window.confirm，
 * 好处是跟着应用主题走、能排版多行后果说明。
 *
 * 初始焦点刻意放在「取消」上：危险操作默认不聚焦，
 * 免得回车 / 空格（或按键repeat）直接落到删除上。
 */
export default function ConfirmDialog({
  title,
  icon = "alert-triangle",
  children,
  confirmText = "确定",
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-label={title}
        className="dialog"
        style={{ width: 400 }}
      >
        <header>
          <Icon name={icon} size={15} />
          {title}
        </header>

        <div className="body">
          <div className={danger ? "banner warn" : "banner info"}>
            <Icon name={danger ? "alert-triangle" : "info"} />
            <span>{children}</span>
          </div>
        </div>

        <footer>
          <button
            type="button"
            className="btn outline"
            onClick={onCancel}
            autoFocus
          >
            取消
          </button>
          <button
            type="button"
            className={`btn ${danger ? "outline danger" : "primary"}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
