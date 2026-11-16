import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, type CommandRecord } from "../lib/api";
import { useDialogFocus } from "../lib/dialog";
import type { Snippet } from "../lib/types";
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
 * 命令历史 / 常用片段面板。
 *
 * 历史：展示在终端里执行过的命令，支持跨主机检索与一键重放。
 * 片段：用户手动维护的常用命令，可随时发送到当前终端。
 *
 * 两套机制不重叠：远端 shell 的方向键管「刚刚敲过的」，这里管「找回来」。
 */
export default function CommandHistoryPanel({
  hostId,
  aliases,
  onClose,
  onRun,
  onError,
}: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();
  const [mode, setMode] = useState<"history" | "snippets">("history");

  const [records, setRecords] = useState<CommandRecord[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"host" | "all">("all");
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetName, setSnippetName] = useState("");
  const [snippetCmd, setSnippetCmd] = useState("");
  /** 正在编辑的片段 id；null 表示新建 */
  const [editingSnippet, setEditingSnippet] = useState<number | null>(null);
  const [snippetBusy, setSnippetBusy] = useState(false);
  const [deletingSnippet, setDeletingSnippet] = useState<Snippet | null>(null);

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

  const loadSnippets = useCallback(async () => {
    try {
      setSnippets(await api.listSnippets());
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [onError]);

  // 输入停顿后再查，避免每敲一个字符就打一次数据库
  useEffect(() => {
    const timer = setTimeout(load, 180);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (mode === "snippets") void loadSnippets();
  }, [mode, loadSnippets]);

  const clear = async () => {
    try {
      await api.clearCommandHistory(effectiveHostId);
      await load();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const resetSnippetForm = () => {
    setEditingSnippet(null);
    setSnippetName("");
    setSnippetCmd("");
  };

  /** 从历史行带入命令，方便「这条命令以后还会用」的场景 */
  const draftFromHistory = (command: string) => {
    setEditingSnippet(null);
    setSnippetName("");
    setSnippetCmd(command);
    setMode("snippets");
  };

  const editSnippet = (s: Snippet) => {
    setEditingSnippet(s.id);
    setSnippetName(s.name);
    setSnippetCmd(s.command);
  };

  const saveSnippet = async () => {
    if (!snippetName.trim()) return onError("片段名称不能为空");
    if (!snippetCmd.trim()) return onError("片段命令不能为空");
    setSnippetBusy(true);
    try {
      await api.saveSnippet(snippetName, snippetCmd, editingSnippet);
      resetSnippetForm();
      await loadSnippets();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setSnippetBusy(false);
    }
  };

  const confirmDeleteSnippet = async () => {
    const target = deletingSnippet;
    if (!target) return;
    setDeletingSnippet(null);
    try {
      await api.deleteSnippet(target.id);
      if (editingSnippet === target.id) resetSnippetForm();
      await loadSnippets();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const title = useMemo(() => {
    if (mode === "snippets") return "常用命令片段";
    return scope === "host" && hostId
      ? `命令历史 · ${aliases[hostId] ?? hostId}`
      : "命令历史";
  }, [mode, scope, hostId, aliases]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-label={title}
        className="dialog hist-dialog"
      >
        <header>
          <Icon name="terminal" size={15} />
          {title}
          <div className="seg-switch hist-mode">
            <button
              className={mode === "history" ? "on" : ""}
              onClick={() => setMode("history")}
            >
              历史
            </button>
            <button
              className={mode === "snippets" ? "on" : ""}
              onClick={() => setMode("snippets")}
            >
              片段
            </button>
          </div>
        </header>

        <div className="body">
          {mode === "history" ? (
            <>
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
                    disabled={!hostId}
                    onClick={() => setScope("host")}
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
                        <span className="hist-time">
                          {relativeTime(r.createdAt)}
                        </span>
                      </span>
                    </div>
                    <div className="hist-actions">
                      <button
                        className="btn sm icon"
                        onClick={() => draftFromHistory(r.command)}
                        title="存为片段"
                        aria-label="存为片段"
                      >
                        <Icon name="plus" size={12} />
                      </button>
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
            </>
          ) : (
            <>
              <div className="snippet-form">
                <div className="row">
                  <input
                    value={snippetName}
                    onChange={(e) => setSnippetName(e.target.value)}
                    placeholder="片段名称，例如 查看磁盘"
                    aria-label="片段名称"
                  />
                </div>
                <div className="row">
                  <input
                    className="mono"
                    value={snippetCmd}
                    onChange={(e) => setSnippetCmd(e.target.value)}
                    placeholder="命令内容，例如 df -h"
                    aria-label="片段命令"
                  />
                  <button
                    className="btn primary"
                    onClick={saveSnippet}
                    disabled={snippetBusy}
                  >
                    <Icon name="check" size={13} />
                    {editingSnippet ? "保存修改" : "保存片段"}
                  </button>
                  {(editingSnippet !== null ||
                    snippetName ||
                    snippetCmd) && (
                    <button className="btn outline" onClick={resetSnippetForm}>
                      取消
                    </button>
                  )}
                </div>
              </div>

              <div className="hist-list">
                {snippets.length === 0 && (
                  <div className="sftp-empty">
                    还没有片段，填写名称和命令后保存
                  </div>
                )}
                {snippets.map((s) => (
                  <div key={s.id} className="hist-row">
                    <div className="hist-main">
                      <span className="hist-cmd snippet-name">{s.name}</span>
                      <span className="hist-meta">
                        <span className="hist-cmd" title={s.command}>
                          {s.command}
                        </span>
                      </span>
                    </div>
                    <div className="hist-actions">
                      <button
                        className="btn sm icon"
                        onClick={() => editSnippet(s)}
                        title="编辑片段"
                        aria-label="编辑片段"
                      >
                        <Icon name="pencil" size={12} />
                      </button>
                      <button
                        className="btn sm icon"
                        onClick={() => setDeletingSnippet(s)}
                        title="删除片段"
                        aria-label="删除片段"
                      >
                        <Icon name="trash" size={12} />
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => onRun(s.command)}
                        title="发送到终端"
                      >
                        <Icon name="terminal" size={12} />
                        执行
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <footer>
          <span className="spacer" />
          {mode === "history" && (
            <button
              className="btn outline"
              onClick={() => setConfirmClear(true)}
            >
              <Icon name="trash" size={13} />
              清空历史
            </button>
          )}
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

        {deletingSnippet && (
          <ConfirmDialog
            title="删除片段"
            icon="trash"
            confirmText="删除"
            danger
            onCancel={() => setDeletingSnippet(null)}
            onConfirm={() => void confirmDeleteSnippet()}
          >
            确定删除片段「{deletingSnippet.name}」？此操作不可恢复。
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}
