/**
 * 远程文件编辑器对话框。
 *
 * 编辑器不再占据终端页签，改为独立的模态窗口：
 * - 顶部下拉可在多个已打开的编辑器之间切换；
 * - 关闭时若有未保存修改，先弹确认；
 * - 内容草稿仍由 editorTabs store 持有，切换不会丢失。
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import ConfirmDialog from "./ConfirmDialog";
import { EditorTabView } from "./EditorTab";
import type { EditorTab as EditorTabModel } from "../lib/editorTabs";
import type { TabStatus } from "../lib/tabs";

interface Props {
  tabs: EditorTabModel[];
  activeId: string | null;
  /** 查询编辑器所属 SSH 会话的连接状态 */
  sessionStatus: (sessionId: string) => TabStatus;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRequestSave: (tab: EditorTabModel) => void;
  /** 保存 / 冲突对话框打开时，屏蔽本对话框的 Escape 与背景点击 */
  blocked?: boolean;
}

export function EditorDialog({
  tabs,
  activeId,
  sessionStatus,
  onSelect,
  onClose,
  onRequestSave,
  blocked = false,
}: Props) {
  const [confirmClose, setConfirmClose] = useState(false);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  // 活动标签被外部清理（会话关闭等）时，关闭确认框不应残留
  useEffect(() => {
    if (!active) setConfirmClose(false);
  }, [active]);

  if (!active) return null;

  /**
   * 内容是否与最近一次读取/保存的结果一致。
   * savedText 在打开、重载、保存成功三处同步更新，是唯一可信基准；
   * contentBase64 只是打开时的快照，保存后不会变化，不能用于此处比对。
   */
  const isUnchanged = () => {
    if (!active) return true;
    const normalize = (s: string) => s.replace(/\r\n?/g, "\n");
    return normalize(active.text) === normalize(active.savedText ?? "");
  };

  const requestClose = () => {
    if (blocked) return;
    if (isUnchanged()) onClose(active.id);
    else setConfirmClose(true);
  };

  return createPortal(
    <>
      <div
        className="overlay editor-modal-overlay"
        onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
      >
        <div
          className="dialog editor-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`编辑文件 ${active.name}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              requestClose();
            }
          }}
        >
          <header>
            <Icon name="file" size={14} />
            {tabs.length > 1 ? (
              <select
                className="editor-modal-switch"
                value={active.id}
                onChange={(e) => onSelect(e.target.value)}
                title="切换编辑器"
              >
                {tabs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.alias} · {t.name}
                    {t.dirty ? " ●" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="editor-modal-title">{active.name}</span>
            )}
            <span className="editor-modal-path">
              {active.alias} · {active.path}
            </span>
          </header>
          <div className="editor-modal-body">
            <EditorTabView
              key={active.id}
              tab={active}
              sessionStatus={sessionStatus(active.sessionId)}
              onRequestSave={onRequestSave}
            />
          </div>
          <footer className="editor-modal-footer">
            <div className="editor-badges">
              {active.meta.readOnly && <span className="editor-badge">只读</span>}
              {active.dirty && <span className="editor-badge dirty">未保存</span>}
            </div>
            <button
              type="button"
              className="btn outline"
              disabled={blocked}
              onClick={requestClose}
            >
              关闭
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={blocked || (active.meta.readOnly && !active.meta.needsElevation)}
              onClick={() => onRequestSave(active)}
            >
              保存
            </button>
          </footer>
        </div>
      </div>

      {confirmClose && (
        <ConfirmDialog
          title="关闭编辑器"
          icon="file"
          confirmText="放弃修改并关闭"
          danger
          onCancel={() => setConfirmClose(false)}
          onConfirm={() => {
            setConfirmClose(false);
            onClose(active.id);
          }}
        >
          <span>
            <strong>{active.name}</strong> 有未保存的修改，关闭后将丢失这些改动。
          </span>
        </ConfirmDialog>
      )}
    </>,
    document.body
  );
}
