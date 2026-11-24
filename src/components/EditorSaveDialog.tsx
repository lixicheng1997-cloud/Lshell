/** 保存冲突 / sudo 提权 / 保存失败的确认对话框。 */

import { useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import type { EditorTab } from "../lib/editorTabs";

export interface SaveChoice {
  force?: boolean;
  elevation?:
    | { mode: "passwordless" }
    | { mode: "password"; password: string }
    | null;
}

interface Props {
  kind: "elevate" | "conflict" | "error";
  tab: EditorTab;
  remoteText?: string;
  message?: string;
  /** 设置项 editor.allowSudoPassword，默认关闭 */
  allowPassword?: boolean;
  onConfirm: (choice: SaveChoice) => void;
  onReload: () => void;
  onCancel: () => void;
}

export function EditorSaveDialog({
  kind,
  tab,
  remoteText,
  message,
  allowPassword = false,
  onConfirm,
  onReload,
  onCancel,
}: Props) {
  const [password, setPassword] = useState("");

  const title =
    kind === "elevate" ? "需要提权保存" : kind === "conflict" ? "远端文件已被修改" : "保存失败";
  const icon = kind === "error" ? "alert-triangle" : "info";

  const submit = (choice: SaveChoice) => {
    onConfirm(choice);
    setPassword("");
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
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width: 520 }}>
        <header>
          <Icon name={icon} size={15} />
          {title}
        </header>

        <div className="body">
          {kind === "elevate" && (
            <>
              <div className="banner info">
                <Icon name="info" />
                <span>
                  当前账号对该文件没有写权限。保存前会先备份原文件，并以 sudo 在目标同目录原子替换。
                </span>
              </div>
              <p className="editor-dialog-path">{tab.path}</p>
              {allowPassword && (
                <label className="editor-dialog-field">
                  sudo 密码（仅保存在内存中，用完即清零，不会写入日志或数据库）
                  <input
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="留空并使用免密 sudo 时可直接点下方第一项"
                  />
                </label>
              )}
            </>
          )}

          {kind === "conflict" && (
            <>
              <div className="banner warn">
                <Icon name="alert-triangle" />
                <span>打开后该文件被其他进程修改。请确认差异后再决定如何处理。</span>
              </div>
              <pre className="editor-dialog-diff">
                {(remoteText ?? "").split("\n").slice(0, 30).join("\n")}
              </pre>
            </>
          )}

          {kind === "error" && (
            <div className="banner warn">
              <Icon name="alert-triangle" />
              <span>{message ?? "未知错误"}</span>
            </div>
          )}
        </div>

        <footer>
          <button type="button" className="btn outline" onClick={onCancel} autoFocus>
            取消
          </button>

          {kind === "elevate" && (
            <>
              <button
                type="button"
                className="btn outline"
                onClick={() => submit({ elevation: { mode: "passwordless" } })}
              >
                免密 sudo 保存
              </button>
              {allowPassword && password.length > 0 && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() =>
                    submit({ elevation: { mode: "password", password } })
                  }
                >
                  使用密码提权保存
                </button>
              )}
            </>
          )}

          {kind === "conflict" && (
            <>
              <button type="button" className="btn outline" onClick={onReload}>
                重新加载远端内容
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => submit({ force: true })}
              >
                用我的内容强制覆盖（仍会备份）
              </button>
            </>
          )}

          {kind === "error" && (
            <button type="button" className="btn primary" onClick={onCancel}>
              知道了
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}
