import { createPortal } from "react-dom";
import { useDialogFocus } from "../lib/dialog";
import Icon from "./Icon";
import type { ImportPreview } from "../lib/types";

interface Props {
  preview: ImportPreview;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 导入预检对话框。
 *
 * 先把解析结果给用户看一眼再落库：文件可能是别人给的，
 * 直接塞进主机库会让侧栏突然多出一堆不认识的主机。
 */
export default function ImportDialog({
  preview,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();
  const importable = preview.candidates.length - preview.duplicates;
  const formatLabel = preview.format === "json" ? "Lshell JSON" : "SSH 配置";

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
        aria-label="导入主机"
        className="dialog"
        style={{ width: 560 }}
      >
        <header>
          <Icon name="upload" size={15} />
          导入主机
        </header>

        <div className="body">
          <div className="banner info">
            <Icon name="info" />
            <span>
              来源：{formatLabel} · {preview.path}
            </span>
          </div>

          <div className="import-summary">
            <span>
              解析出 <b>{preview.candidates.length}</b> 台主机
            </span>
            {preview.duplicates > 0 && (
              <span className="muted">
                其中 {preview.duplicates} 台与现有主机重复，将跳过
              </span>
            )}
            <span className="muted">本次将导入 {importable} 台</span>
          </div>

          <div className="import-list">
            {preview.candidates.length === 0 && (
              <div className="import-empty">没有可导入的主机</div>
            )}
            {preview.candidates.map((c, i) => {
              return (
                <div key={`${c.alias}-${i}`} className="import-row">
                  <Icon name="server" size={12} />
                  <span className="name">{c.alias}</span>
                  <span className="addr">
                    {c.username ? `${c.username}@` : ""}
                    {c.address}:{c.port}
                  </span>
                  {c.keyPath && <span className="tag">私钥</span>}
                  {c.jump && (
                    <span className="tag" title={`ProxyJump: ${c.jump}`}>
                      跳板
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {preview.warnings.length > 0 && (
            <div className="import-warnings">
              {preview.warnings.slice(0, 6).map((w, i) => (
                <div key={i} className="muted">
                  第 {w.line} 行：{w.message}
                </div>
              ))}
              {preview.warnings.length > 6 && (
                <div className="muted">
                  另有 {preview.warnings.length - 6} 条提示未显示
                </div>
              )}
            </div>
          )}

          <div className="muted" style={{ fontSize: 12 }}>
            导入的主机不含密码：有私钥的按密钥认证，其余按本机 SSH Agent
            认证，可稍后逐台编辑。
          </div>
        </div>

        <footer>
          <button type="button" className="btn outline" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={onConfirm}
            disabled={busy || importable <= 0}
          >
            {busy ? "导入中…" : `导入 ${importable} 台`}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
