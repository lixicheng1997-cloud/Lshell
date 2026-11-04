import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type TransferStatus } from "../lib/api";
import type { TabStatus } from "../lib/tabs";
import { notify } from "../lib/toast";
import Icon from "./Icon";
import ConfirmDialog from "./ConfirmDialog";
import PromptDialog from "./PromptDialog";

interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
}

/** 传输项在快照基础上补上派生信息（速度、采样时刻） */
interface TransferView extends TransferStatus {
  /** 字节/秒 */
  speed: number;
  /** 本次采样的时刻 */
  at: number;
}

interface Props {
  sessionId: string;
  /** 面板折叠 */
  collapsed: boolean;
  onToggle: () => void;
  /** 终端上报的当前目录（OSC 7） */
  cwd: string | null;
  /** 是否跟随终端目录 */
  follow: boolean;
  onFollowChange: (next: boolean) => void;
  onError: (msg: string) => void;
  /**
   * 当前会话的连接状态；null 表示没有选中任何远程连接。
   *
   * 只有 status === "connected" 才允许浏览和操作远端文件，
   * 连接中 / 失败 / 断开时面板只展示提示，不发任何 SFTP 请求。
   */
  status: TabStatus | null;
  /**
   * 外部跳转请求。
   *
   * 右键菜单「在文件面板打开当前目录」用它把面板带到指定路径。
   * `nonce` 每次请求都会变化，用来区分「同一路径的重复请求」。
   */
  jumpTo?: { path: string; nonce: number } | null;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 速度文案 */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "";
  return `${formatSize(bytesPerSec)}/s`;
}

/** 剩余时间文案 */
function formatEta(speed: number, remaining: number): string {
  if (speed <= 0 || remaining <= 0) return "";
  const secs = Math.round(remaining / speed);
  if (secs < 60) return `剩 ${secs} 秒`;
  if (secs < 3600) return `剩 ${Math.round(secs / 60)} 分钟`;
  return `剩 ${(secs / 3600).toFixed(1)} 小时`;
}

/** 传输状态对应的中文标签 */
function transferLabel(state: TransferStatus["state"]): string {
  switch (state) {
    case "running":
      return "传输中";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    default:
      return "失败";
  }
}

/** 迷你开关 */
function Toggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  title: string;
}) {
  return (
    <label className="switch" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track">
        <span className="thumb" />
      </span>
      <span className="sw-label">{label}</span>
    </label>
  );
}

/**
 * 远端文件面板。
 *
 * 面包屑按路径逐级可点，双击目录进入。
 * 开启「跟随终端」后，面板会跟随 shell 上报的当前目录（OSC 7）自动切换；
 * 用户手动浏览过就不再强制跳转，可一键回到终端目录。
 */
export default function SftpPanel({
  sessionId,
  collapsed,
  onToggle,
  cwd,
  follow,
  onFollowChange,
  onError,
  jumpTo,
  status,
}: Props) {
  /** 只有已连接的会话才能浏览 / 操作远端文件 */
  const connected = status === "connected";
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** 用户手动导航过 —— 此时不跟随终端目录 */
  const [manual, setManual] = useState(false);
  /** 待删除的远端条目：非空时弹确认框 */
  const [deleting, setDeleting] = useState<RemoteEntry | null>(null);
  /** 新建目录对话框 */
  const [creatingDir, setCreatingDir] = useState(false);
  /** 传输任务列表 */
  const [transfers, setTransfers] = useState<TransferView[]>([]);
  /** 指针是否拖着文件悬停在面板上 */
  const [dragOver, setDragOver] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  /** 当前目录的 ref：轮询回调里要用，避免闭包拿到旧值 */
  const pathRef = useRef(path);
  pathRef.current = path;
  /** 连接状态的 ref：load / 轮询回调里用它拦截未连接时的请求 */
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  /** 已经提示过完成的传输，避免重复刷新目录 */
  const doneRef = useRef<Set<number>>(new Set());

  const load = useCallback(
    async (target: string) => {
      // 未连接时不出请求：连接失败也不会在面板上炸一串错误
      if (!connectedRef.current) return;
      setLoading(true);
      try {
        const listing = await api.sftpList(sessionId, target);
        setEntries(listing.entries);
        // 用解析后的绝对路径，初始 "." 会变成用户主目录
        setPath(listing.path);
        setSelected(null);
      } catch (e) {
        onError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, onError]
  );

  /** 手动导航：标记为脱离终端目录 */
  const navigate = useCallback(
    (target: string) => {
      setManual(true);
      void load(target);
    },
    [load]
  );

  // 会话切换、面板展开或连接就绪时（重新）加载目录。
  // 连接中打开面板不会请求；等到 status 变为 connected 再触发，
  // 这样新连接一就绪文件列表就立刻出现。
  useEffect(() => {
    if (collapsed || !connected) return;
    setManual(false);
    const target = follow && cwd ? cwd : ".";
    void load(target);
    // 面板展开、会话变化或连接就绪时刷新
  }, [collapsed, sessionId, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // 终端目录变化时跟随
  useEffect(() => {
    if (!follow || !cwd || !connected) return;
    if (cwd === path) return;
    setManual(false);
    void load(cwd);
  }, [follow, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // 外部跳转请求：面板直接去到指定路径
  useEffect(() => {
    if (!jumpTo || collapsed || !connected) return;
    setManual(true);
    void load(jumpTo.path);
    // 只在 nonce 变化时触发
  }, [jumpTo?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 逐级返回上级目录 */
  const goUp = () => {
    if (!path.startsWith("/")) return;
    const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    navigate(parent || "/");
  };

  const enter = (entry: RemoteEntry) => {
    if (entry.isDir) {
      navigate(entry.path);
    } else {
      setSelected(entry.path);
    }
  };

  const download = async (entry: RemoteEntry) => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        defaultPath: entry.name,
        title: "保存到本地",
      });
      if (!target) return;
      // 传输在后台跑，进度在面板底部展示
      await api.sftpDownload(sessionId, entry.path, target);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  /** 上传一个本地文件到当前远端目录 */
  const uploadOne = useCallback(
    async (local: string) => {
      const name = local.split(/[\\/]/).pop() ?? "file";
      const remote = `${pathRef.current.replace(/\/$/, "")}/${name}`;
      await api.sftpUpload(sessionId, local, remote);
    },
    [sessionId]
  );

  const upload = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false });
      if (typeof picked !== "string") return;
      await uploadOne(picked);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  /**
   * 拖拽上传：把本地文件拖到面板上即可传到当前远端目录。
   *
   * Tauri 的拖放事件是 webview 级的（整个窗口都能收到），
   * 因此要额外判断落点是否在面板内。
   */
  const uploadPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      let failed = 0;
      for (const local of paths) {
        try {
          await uploadOne(local);
        } catch (e) {
          failed++;
          onError(errorMessage(e));
        }
      }
      if (failed === 0) {
        const count = paths.length;
        notify.success(
          count === 1 ? "已开始上传" : `已开始上传 ${count} 个文件`
        );
      }
    },
    [uploadOne, onError]
  );

  // 传输进度轮询：进度由 Rust 侧维护，这里只做展示。
  // 面板折叠时也要继续轮询，否则折叠态徽标上的数量会不准。
  useEffect(() => {
    let alive = true;

    const poll = async () => {
      try {
        const list = await api.listTransfers();
        if (!alive) return;
        const now = Date.now();
        setTransfers((prev) => {
          const prevMap = new Map(prev.map((t) => [t.id, t]));
          return list.map((t) => {
            const old = prevMap.get(t.id);
            let speed = 0;
            if (old && t.state === "running" && t.transferred > old.transferred) {
              const dt = (now - old.at) / 1000;
              // 采样间隔太短时算出来的速度噪声很大，直接丢弃
              if (dt >= 0.3) speed = (t.transferred - old.transferred) / dt;
            }
            return { ...t, speed, at: now };
          });
        });

        // 有传输刚完成时刷新目录，让新文件立刻可见
        const finished = list.filter(
          (t) => t.state === "completed" && !doneRef.current.has(t.id)
        );
        if (finished.length > 0) {
          finished.forEach((t) => doneRef.current.add(t.id));
          void load(pathRef.current);
        }
      } catch {
        // 轮询失败不影响其它功能，忽略
      }
    };

    void poll();
    const timer = setInterval(poll, 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  // 拖放：Tauri 的原生拖放事件
  useEffect(() => {
    if (collapsed) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    /** 判断落点是否在面板内；事件坐标是物理像素，DOM 坐标是 CSS 像素 */
    const hitPanel = (x: number, y: number) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const scale = window.devicePixelRatio || 1;
      const cx = x / scale;
      const cy = y / scale;
      return (
        cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom
      );
    };

    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            setDragOver(hitPanel(p.position.x, p.position.y));
          } else if (p.type === "drop") {
            setDragOver(false);
            if (!hitPanel(p.position.x, p.position.y)) return;
            void uploadPaths(p.paths);
          } else {
            setDragOver(false);
          }
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        // 浏览器预览环境没有 webview API
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      setDragOver(false);
    };
  }, [collapsed, uploadPaths]);

  const confirmRemove = async () => {
    const entry = deleting;
    if (!entry) return;
    setDeleting(null);
    try {
      await api.sftpRemove(sessionId, entry.path, entry.isDir);
      notify.success(`已删除 ${entry.name}`);
      void load(path);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  /** 由新建目录对话框调用；抛错时错误信息在对话框内展示 */
  const mkdir = async (name: string) => {
    const remote = `${path.replace(/\/$/, "")}/${name}`;
    await api.sftpMkdir(sessionId, remote);
    notify.success(`已创建目录 ${name}`);
    setCreatingDir(false);
    void load(path);
  };

  if (collapsed) {
    const running = transfers.filter((t) => t.state === "running").length;
    return (
      <div className="sftp-collapsed">
        <button
          onClick={onToggle}
          title={
            running > 0
              ? `展开文件面板 (Ctrl+Shift+F) · ${running} 个传输进行中`
              : "展开文件面板 (Ctrl+Shift+F)"
          }
          aria-label="展开文件面板"
        >
          <Icon name="folder" size={15} />
          {running > 0 && <span className="sftp-badge">{running}</span>}
        </button>
      </div>
    );
  }

  // 未选择会话或会话未成功连接：只展示提示，不出文件列表和操作按钮
  if (!connected) {
    const hint = !sessionId
      ? { title: "未选择远程连接", desc: "请先在左侧选择主机并建立连接" }
      : status === "connecting" || status === "reconnecting"
        ? { title: "正在连接…", desc: "连接成功后即可浏览远端文件" }
        : status === "failed"
          ? { title: "连接失败", desc: "重新连接成功后才能操作远端文件" }
          : { title: "连接已断开", desc: "重新连接成功后才能操作远端文件" };
    return (
      <div ref={panelRef} className="sftp-panel">
        <div className="sftp-head">
          <span className="title">远端文件</span>
          <button
            className="icon-btn"
            onClick={onToggle}
            title="关闭面板 (Ctrl+Shift+F)"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="sftp-offline">
          <Icon name="folder" size={26} />
          <span className="t">{hint.title}</span>
          <span className="d">{hint.desc}</span>
        </div>
      </div>
    );
  }

  // 面包屑：按路径分段，最后一段是当前位置
  const segments = path.split("/").filter(Boolean);
  const crumbPath = (i: number) => "/" + segments.slice(0, i + 1).join("/");
  const detached = follow && !!cwd && manual && cwd !== path;

  return (
    <div
      ref={panelRef}
      className={`sftp-panel ${dragOver ? "drag-over" : ""}`}
    >
      <div className="sftp-head">
        <span className="title">远端文件</span>
        <Toggle
          checked={follow}
          onChange={onFollowChange}
          label="跟随"
          title={
            follow
              ? "已跟随终端当前目录（点击关闭）"
              : "跟随终端当前目录（点击开启）"
          }
        />
        <button className="icon-btn" onClick={() => load(path)} title="刷新">
          <Icon name="refresh" />
        </button>
        <button className="icon-btn" onClick={onToggle} title="关闭面板 (Ctrl+Shift+F)">
          <Icon name="close" />
        </button>
      </div>

      <div className="sftp-crumb" title={path}>
        <Icon name="home" size={13} />
        {segments.length === 0 ? (
          <span className="seg">/</span>
        ) : (
          segments.map((seg, i) => (
            <span key={i} style={{ display: "contents" }}>
              <span className="sep">/</span>
              <span
                className="seg"
                onClick={() => navigate(crumbPath(i))}
                title={crumbPath(i)}
              >
                {seg}
              </span>
            </span>
          ))
        )}
      </div>

      <div className="sftp-toolbar">
        <button className="btn" onClick={upload} title="上传本地文件">
          <Icon name="upload" size={13} />
          上传
        </button>
        <button
          className="btn"
          disabled={!selected}
          onClick={() => {
            const entry = entries.find((e) => e.path === selected);
            if (entry) download(entry);
          }}
          title="下载选中的文件"
        >
          <Icon name="download" size={13} />
          下载
        </button>
        <button
          className="btn"
          onClick={() => setCreatingDir(true)}
          title="新建目录"
        >
          <Icon name="folder-plus" size={13} />
        </button>
        <button className="btn" onClick={goUp} title="上级目录">
          <Icon name="arrow-left" size={13} />
        </button>
      </div>

      <div className="sftp-cols">
        <span>名称</span>
        <span className="size">大小</span>
      </div>

      <div className="sftp-list">
        {loading && <div className="sftp-empty">加载中…</div>}
        {!loading && entries.length === 0 && (
          <div className="sftp-empty">空目录</div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`f-row ${entry.isDir ? "dir" : ""} ${
              selected === entry.path ? "selected" : ""
            }`}
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => enter(entry)}
            title={entry.path}
          >
            <Icon name={entry.isDir ? "folder" : "file"} className="fi" />
            <span className="fname">{entry.name}</span>
            <span className="fsize">
              {entry.isDir ? "" : formatSize(entry.size)}
            </span>
            <button
              className="icon-btn f-del"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                setDeleting(entry);
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
      </div>

      {transfers.length > 0 && (
        <div className="sftp-transfers">
          {transfers.map((t) => {
            const pct =
              t.total > 0
                ? Math.min(100, (t.transferred / t.total) * 100)
                : null;
            const remaining =
              t.total > 0 ? Math.max(0, t.total - t.transferred) : 0;
            return (
              <div key={t.id} className={`tr-row ${t.state}`}>
                <Icon
                  name={t.direction === "upload" ? "upload" : "download"}
                  size={12}
                  className="fi"
                />
                <div className="tr-main">
                  <div className="tr-top">
                    <span className="tr-name" title={t.remotePath}>
                      {t.name}
                    </span>
                    <span className="tr-state">
                      {t.state === "running" && pct !== null
                        ? `${pct.toFixed(0)}%`
                        : transferLabel(t.state)}
                    </span>
                  </div>
                  <div className="tr-bar">
                    <div
                      className="tr-fill"
                      style={{
                        width: `${pct ?? (t.state === "completed" ? 100 : 0)}%`,
                      }}
                    />
                  </div>
                  <div className="tr-sub">
                    <span>
                      {formatSize(t.transferred)}
                      {t.total > 0 ? ` / ${formatSize(t.total)}` : ""}
                    </span>
                    {t.state === "running" && (
                      <>
                        {t.speed > 0 && <span>{formatSpeed(t.speed)}</span>}
                        {formatEta(t.speed, remaining) && (
                          <span>{formatEta(t.speed, remaining)}</span>
                        )}
                      </>
                    )}
                    {t.error && <span className="tr-err">{t.error}</span>}
                  </div>
                </div>
                {t.cancellable && (
                  <button
                    className="icon-btn"
                    title="取消传输"
                    onClick={() => {
                      void api.cancelTransfer(t.id).catch(() => {});
                    }}
                  >
                    <Icon name="close" size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="sftp-foot">
        {detached ? (
          <button
            className="btn sm"
            onClick={() => {
              setManual(false);
              if (cwd) void load(cwd);
            }}
            title="回到终端当前目录"
          >
            <Icon name="crosshair" size={12} />
            回到终端目录
          </button>
        ) : selected ? (
          <span className="mono" title={selected}>
            {selected.split("/").pop()}
          </span>
        ) : (
          <span>双击目录进入 · 选中后可下载</span>
        )}
        <span className="spacer" />
        {follow && cwd && !detached && (
          <span className="mono cwd-hint" title={`终端当前目录：${cwd}`}>
            <Icon name="crosshair" size={11} /> {cwd}
          </span>
        )}
        <span>{entries.length} 项</span>
      </div>

      {dragOver && (
        <div className="sftp-dropzone">
          <div className="sftp-dropcard">
            <Icon name="upload" size={22} />
            <span>松开以上传到当前目录</span>
          </div>
        </div>
      )}

      {creatingDir && (
        <PromptDialog
          title="新建目录"
          icon="folder-plus"
          label="目录名"
          placeholder="logs"
          confirmText="创建"
          validate={(value) =>
            value === "." || value === ".."
              ? "目录名不合法"
              : value.includes("/")
                ? "目录名不能包含 /"
                : null
          }
          onSubmit={mkdir}
          onCancel={() => setCreatingDir(false)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={deleting.isDir ? "删除目录" : "删除文件"}
          icon="trash"
          confirmText="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={confirmRemove}
        >
          确定删除远端{deleting.isDir ? "目录" : "文件"}「{deleting.name}」？
          该操作不可恢复。
        </ConfirmDialog>
      )}
    </div>
  );
}
