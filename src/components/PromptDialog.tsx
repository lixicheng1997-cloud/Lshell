import { useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../lib/api";
import Icon, { type IconName } from "./Icon";

interface Props {
  title: string;
  icon?: IconName;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  /** 额外校验：返回错误信息则拦截提交 */
  validate?: (value: string) => string | null;
  /** 提交；抛错时错误信息直接显示在对话框内 */
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * 单行文本输入对话框（新建分组 / 新建目录 / 重命名等）。
 *
 * 与「新建主机」共用同一套控件：同样的 overlay + dialog 结构、
 * .field 表单排版与 footer 按钮，避免再弹系统原生的 prompt。
 */
export default function PromptDialog({
  title,
  icon = "pencil",
  label,
  placeholder,
  initialValue = "",
  confirmText = "确定",
  validate,
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const text = value.trim();
    if (!text) {
      setError(`${label}不能为空`);
      return;
    }
    const invalid = validate?.(text) ?? null;
    if (invalid) {
      setError(invalid);
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await onSubmit(text);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

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
      <div className="dialog" style={{ width: 420 }}>
        <header>
          <Icon name={icon} size={15} />
          {title}
        </header>

        <div className="body">
          {error && (
            <div className="banner error">
              <Icon name="alert-circle" />
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label>{label}</label>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancel();
                }
              }}
            />
          </div>
        </div>

        <footer>
          <button type="button" className="btn outline" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmText}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
