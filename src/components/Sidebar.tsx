import { useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { notify } from "../lib/toast";
import type { Group, Host } from "../lib/types";
import Icon from "./Icon";
import PromptDialog from "./PromptDialog";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  hosts: Host[];
  groups: Group[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRefresh: () => void;
  /** 新建主机；传入 groupId 时在表单里预选该分组 */
  onNewHost: (groupId?: number | null) => void;
  onEditHost: (host: Host) => void;
  /** 主机被删除后通知外层（用于关掉对应标签页） */
  onHostDeleted?: (hostId: number) => void;
  onError: (msg: string) => void;
}

/** 分组标记色：按 id 循环取色，保证同一分组每次渲染颜色一致 */
function groupColor(id: number): string {
  const palette = ["var(--accent)", "var(--ok)", "var(--warn)", "var(--info)"];
  return palette[Math.abs(id) % palette.length];
}

/**
 * 主机库侧栏。
 *
 * 结构：分组树（可折叠）→ 主机条目。
 * 分组与主机都支持就地编辑与删除：分组重命名是行内输入，
 * 主机编辑复用「编辑主机」对话框。
 */
export default function Sidebar({
  hosts,
  groups,
  selectedId,
  onSelect,
  onRefresh,
  onNewHost,
  onEditHost,
  onHostDeleted,
  onError,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  /** 正在重命名的分组 id */
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  /** 重命名提交的幂等标记，避免 Enter 与 blur 重复提交 */
  const renameGuard = useRef(false);
  /** 新建分组对话框 */
  const [creatingGroup, setCreatingGroup] = useState(false);
  /** 待删除的分组：非空时弹确认框 */
  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);
  /** 待删除的主机：非空时弹确认框 */
  const [deletingHost, setDeletingHost] = useState<Host | null>(null);

  // 按分组归类。未分组的放在「未分组」虚拟分组下。
  const grouped = useMemo(() => {
    const map = new Map<number | null, Host[]>();
    for (const h of hosts) {
      const key = h.groupId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(h);
    }
    return map;
  }, [hosts]);

  const toggle = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---------- 分组操作 ----------

  const startRename = (group: Group) => {
    renameGuard.current = false;
    setRenamingId(group.id);
    setDraftName(group.name);
  };

  const commitRename = async () => {
    if (renameGuard.current) return;
    renameGuard.current = true;

    const id = renamingId;
    setRenamingId(null);
    if (id === null) return;

    const name = draftName.trim();
    const group = groups.find((g) => g.id === id);
    if (!name || !group || name === group.name) return;

    try {
      await api.renameGroup(id, name);
      onRefresh();
      notify.success(`分组已重命名为「${name}」`);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const confirmRemoveGroup = async () => {
    const group = deletingGroup;
    if (!group) return;
    setDeletingGroup(null);
    try {
      await api.deleteGroup(group.id);
      onRefresh();
      notify.success(`已删除分组「${group.name}」`);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  // ---------- 主机操作 ----------

  const confirmRemoveHost = async () => {
    const host = deletingHost;
    if (!host) return;
    setDeletingHost(null);
    try {
      await api.deleteHost(host.id);
      onHostDeleted?.(host.id);
      onRefresh();
      notify.success(`已删除主机「${host.alias}」`);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const renderHost = (host: Host) => (
    <div
      key={host.id}
      className={`host-row ${selectedId === host.id ? "active" : ""}`}
      onClick={() => onSelect(host.id)}
      onDoubleClick={() => onEditHost(host)}
      title={`${host.username}@${host.address}:${host.port} · 双击编辑`}
    >
      <span
        className="sdot"
        style={{
          background: host.tags[0]?.color ?? "var(--line-strong)",
          boxShadow: "none",
        }}
      />
      <span className="name">{host.alias}</span>
      <span className="addr">{host.address}</span>
      <span className="row-actions">
        <button
          className="icon-btn"
          title="编辑主机"
          onClick={(e) => {
            e.stopPropagation();
            onEditHost(host);
          }}
        >
          <Icon name="pencil" size={12} />
        </button>
        <button
          className="icon-btn danger"
          title="删除主机"
          onClick={(e) => {
            e.stopPropagation();
            setDeletingHost(host);
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      </span>
    </div>
  );

  const renderGroup = (
    key: number,
    name: string,
    list: Host[],
    color: string,
    group: Group | null
  ) => {
    const isCollapsed = collapsed.has(key);
    const renaming = group !== null && renamingId === group.id;

    return (
      <div key={key}>
        <div
          className={`grp-head ${isCollapsed ? "collapsed" : ""}`}
          onClick={() => toggle(key)}
        >
          <Icon name="chevron-down" className="chev" />
          <span className="sq" style={{ background: color }} />
          {renaming ? (
            <input
              className="grp-rename"
              value={draftName}
              autoFocus
              spellCheck={false}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  renameGuard.current = true;
                  setRenamingId(null);
                }
              }}
              onBlur={commitRename}
            />
          ) : (
            <span className="name">{name}</span>
          )}
          <span className="count">{list.length}</span>
          <span className="row-actions">
            <button
              className="icon-btn"
              title={group ? `在「${name}」下新建主机` : "新建主机（未分组）"}
              onClick={(e) => {
                e.stopPropagation();
                onNewHost(group?.id ?? null);
              }}
            >
              <Icon name="plus" size={12} />
            </button>
            {group && (
              <>
                <button
                  className="icon-btn"
                  title="重命名分组"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(group);
                  }}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <button
                  className="icon-btn danger"
                  title="删除分组"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingGroup(group);
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </>
            )}
          </span>
        </div>
        {!isCollapsed && (
          <div className="grp-body">{list.map(renderHost)}</div>
        )}
      </div>
    );
  };

  /** 由新建分组对话框调用；抛错时错误信息在对话框内展示 */
  const createGroup = async (name: string) => {
    await api.createGroup(name);
    onRefresh();
    setCreatingGroup(false);
    notify.success(`已新建分组「${name}」`);
  };

  return (
    <aside className="sidebar">
      <div className="side-head">
        <span className="label">主机库</span>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            className="icon-btn"
            onClick={() => setCreatingGroup(true)}
            title="新建分组"
          >
            <Icon name="folder-plus" />
          </button>
          <button
            className="icon-btn accent"
            onClick={() => onNewHost()}
            title="新建主机"
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>

      <div className="side-scroll">
        {groups.map((g) =>
          renderGroup(
            g.id,
            g.name,
            grouped.get(g.id) ?? [],
            groupColor(g.id),
            g
          )
        )}

        {(grouped.get(null)?.length ?? 0) > 0 &&
          renderGroup(-1, "未分组", grouped.get(null)!, "var(--fg-faint)", null)}

        {groups.length === 0 && hosts.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: "24px 12px" }}>
            <span className="glyph">
              <Icon name="server" />
            </span>
            <span className="title">还没有主机</span>
            <span className="hint">点击右上角「+」添加第一台服务器</span>
          </div>
        )}

      </div>

      {creatingGroup && (
        <PromptDialog
          title="新建分组"
          icon="folder-plus"
          label="名称"
          placeholder="生产环境"
          confirmText="创建"
          onSubmit={createGroup}
          onCancel={() => setCreatingGroup(false)}
        />
      )}

      {deletingGroup && (
        <ConfirmDialog
          title="删除分组"
          icon="trash"
          confirmText="删除"
          danger
          onCancel={() => setDeletingGroup(null)}
          onConfirm={confirmRemoveGroup}
        >
          确定删除分组「{deletingGroup.name}」？
          {(grouped.get(deletingGroup.id)?.length ?? 0) > 0 &&
            ` 组内 ${grouped.get(deletingGroup.id)!.length} 台主机会移到「未分组」。`}
        </ConfirmDialog>
      )}

      {deletingHost && (
        <ConfirmDialog
          title="删除主机"
          icon="trash"
          confirmText="删除"
          danger
          onCancel={() => setDeletingHost(null)}
          onConfirm={confirmRemoveHost}
        >
          确定删除主机「{deletingHost.alias}」？该操作不可恢复，已打开的对应会话也会关闭。
        </ConfirmDialog>
      )}
    </aside>
  );
}
