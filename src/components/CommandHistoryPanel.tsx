import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, type CommandRecord } from "../lib/api";
import Icon from "./Icon";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  /** 当前标签所属主机；null 表示跨全部主机 */
  hostId: number | null;
  /** 主机别名表，用于把 hostId 显示成可读名字 */
  aliases: Record<number, string>;
  onClose: () => void;
  /** 把一条命令送回终端 */
  onRun: (command: string) => void;
  onError: (msg: string) => void;
}

/** 相对时间文案 */
function relativeTime(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000) - ts;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

/**
 * 命令历史面板。
 *
 * 展示在终端里执行过的命令，支持跨主机检索与一键重放。
 * 这是「命令历史」的检索入口 —— 方向键召回由远端 shell 自己负责，
 * 两套机制不重叠：远端管「刚刚敲过的」，这里管「找回来」。
 */
export default function CommandHistoryPanel({
  hostId,
  aliases,
  onClose,
  onRun,
  onError,
}: Props) {
  const [records, setRecords] = useState<CommandRecord[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"host" | "all">("all");
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  const effectiveHostId = scope === "host" ? hostId : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listCommandHistory(effectiveHostId, query, 300);
      setRecords(list);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [effectiveHostId, query, onError]);

  // 输入停顿后再查，避免每敲一个字符就打一次数据库
  useEffect(() => {
    const timer = setTimeout(load, 180);
    return () => clearTimeout(timer);
  }, [load]);

  const clear = async () => {
    try {
      await api.clearCommandHistory(effectiveHostId);
      await load();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const title = useMemo(
    () => (scope === "host" && hostId ? `命令历史 · ${aliases[hostId] ?? hostId}` : "命令历史"),
    [scope, hostId, aliases]
  );

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog hist-dialog">
        <header>
          <Icon name="terminal" size={15} />
          {title}
        </header>

        <div className="body">
          <div className="hist-toolbar">
            <label className="omni hist-search">
              <input
                className="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索命令"
                spellCheck={false}
                autoFocus
              />
            </label>

            <div className="seg-switch" role="tablist" aria-label="历史范围">
              <button
                className={scope === "all" ? "on" : ""}
                onClick={() => setScope("all")}
                title="跨全部主机"
              >
                全部
              </button>
              <button
                className={scope === "host" ? "on" : ""}
                onClick={() => setScope("host")}
                disabled={!hostId}
                title={hostId ? "仅当前主机" : "没有选中的主机"}
              >
                当前主机
              </button>
            </div>
          </div>

          <div className="hist-list">
            {loading && records.length === 0 && (
              <div className="sftp-empty">加载中…</div>
            )}
            {!loading && records.length === 0 && (
              <div className="sftp-empty">
                {query ? "没有匹配的命令" : "还没有命令记录"}
              </div>
            )}
            {records.map((r) => (
              <div key={r.id} className="hist-row">
                <div className="hist-main">
                  <span className="hist-cmd" title={r.command}>
                    {r.command}
                  </span>
                  <span className="hist-meta">
                    <span className="hist-host">
                      {aliases[r.hostId] ?? `主机 ${r.hostId}`}
                    </span>
                    {r.cwd && (
                      <span className="hist-cwd" title={r.cwd}>
                        {r.cwd}
                      </span>
                    )}
                    <span className="hist-time">{relativeTime(r.createdAt)}</span>
                  </span>
                </div>
                <div className="hist-actions">
                  <button
                    className="btn sm"
                    onClick={() => onRun(r.command)}
                    title="发送到终端"
                  >
                    <Icon name="terminal" size={12} />
                    执行
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <footer>
          <span className="spacer" />
          <button className="btn outline" onClick={() => setConfirmClear(true)}>
            <Icon name="trash" size={13} />
            清空历史
          </button>
          <button className="btn outline" onClick={onClose}>
            关闭
          </button>
        </footer>

        {confirmClear && (
          <ConfirmDialog
            title="清空命令历史"
            icon="trash"
            confirmText="清空"
            danger
            onCancel={() => setConfirmClear(false)}
            onConfirm={async () => {
              setConfirmClear(false);
              await clear();
            }}
          >
            确定清空
            {scope === "host" && hostId
              ? `「${aliases[hostId] ?? hostId}」`
              : "全部主机"}
            的命令历史？此操作不可恢复。
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}
