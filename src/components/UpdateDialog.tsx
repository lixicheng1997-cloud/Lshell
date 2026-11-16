import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import Icon from "./Icon";
import { api, type UpdateInfo, type UpdateProgress } from "../lib/api";
import { useDialogFocus } from "../lib/dialog";
import {
  describeUpdateFailure,
  formatBytes,
  type UpdateFailureDetail,
} from "../lib/update";
import { notify } from "../lib/toast";

interface Props {
  info: UpdateInfo;
  onClose: () => void;
}

type Phase = "idle" | "downloading" | "ready" | "applying";

/**
 * 更新提示框。
 *
 * 三个阶段都要用户显式确认：发现版本 → 主动下载 → 主动重启。
 * 下载在后台进行，不阻塞或关闭现有 SSH 会话。
 */
export default function UpdateDialog({ info, onClose }: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<UpdateFailureDetail | null>(null);

  useEffect(() => {
    if (phase !== "downloading") return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<UpdateProgress>("update://progress", (event) => {
          if (!disposed) setProgress(event.payload);
        });
      } catch {
        // 浏览器预览环境没有事件 API
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [phase]);

  const download = async () => {
    setError(null);
    setProgress(null);
    setPhase("downloading");
    try {
      await api.downloadUpdate();
      setPhase("ready");
    } catch (e) {
      setPhase("idle");
      setError(describeUpdateFailure(e));
    }
  };

  const apply = async () => {
    setPhase("applying");
    try {
      await api.applyUpdate();
      // Windows 上安装器会结束当前进程，成功返回时通常已经在退出途中
    } catch (e) {
      setPhase("ready");
      const failure = describeUpdateFailure(e);
      notify.error(`${failure.title}：${failure.advice}`);
    }
  };

  const percent = progress?.percent;
  const canClose = phase === "idle" || phase === "ready";

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && canClose && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && canClose) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-label={phase === "ready" ? "更新已就绪" : "发现新版本"}
        className="dialog"
        style={{ width: 460 }}
      >
        <header>
          <Icon name={phase === "ready" ? "check" : "download"} size={15} />
          {phase === "ready" ? "更新已就绪" : "发现新版本"}
        </header>

        <div className="body">
          {phase !== "ready" && (
            <div className="banner info">
              <Icon name="info" />
              <span>
                Lshell <strong>{info.currentVersion}</strong> →{" "}
                <strong>{info.version}</strong>
                {info.date ? `（${info.date} 发布）` : ""}
                {info.size != null ? ` · ${formatBytes(info.size)}` : ""}
              </span>
            </div>
          )}

          {info.notes && phase !== "ready" && (
            <div
              className="update-notes"
              style={{
                maxHeight: 180,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                padding: "9px 10px",
                background: "var(--bg-app)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-sm)",
                color: "var(--fg-muted)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {info.notes}
            </div>
          )}

          {phase === "downloading" && (
            <div className="field">
              <label>
                正在后台下载
                {percent != null ? ` ${percent}%` : "…"}
              </label>
              <div className="settings-desc">
                {progress
                  ? `${formatBytes(progress.downloaded)}${
                      progress.total ? ` / ${formatBytes(progress.total)}` : ""
                    }`
                  : "已开始下载，请稍候…"}
                下载完成后会校验签名，再提示你重启。
              </div>
            </div>
          )}

          {phase === "ready" && (
            <div className="banner info">
              <Icon name="check" />
              <span>
                新版本已下载并通过签名校验。重启后会完成安装，当前 SSH
                会话会随应用一起结束；也可以稍后自己重启。
              </span>
            </div>
          )}

          {phase === "applying" && (
            <div className="settings-desc">正在启动安装器，请稍候…</div>
          )}

          {error && (
            <div className="banner warn">
              <Icon name="alert-triangle" />
              <span>
                <strong>{error.title}</strong>
                <br />
                {error.advice}
                <br />
                <span className="update-error-detail">{error.detail}</span>
              </span>
            </div>
          )}
        </div>

        <footer>
          {phase === "idle" && (
            <>
              <button type="button" className="btn outline" onClick={onClose}>
                稍后
              </button>
              <button type="button" className="btn primary" onClick={download}>
                <Icon name="download" size={14} />
                下载更新
              </button>
            </>
          )}
          {phase === "downloading" && (
            <span className="settings-desc">下载完成后会提示你重启</span>
          )}
          {phase === "ready" && (
            <>
              <button type="button" className="btn outline" onClick={onClose}>
                稍后
              </button>
              <button type="button" className="btn primary" onClick={apply}>
                <Icon name="refresh" size={14} />
                重启以完成更新
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}
