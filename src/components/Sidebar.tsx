import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api, errorMessage } from "../lib/api";
import { notify } from "../lib/toast";
import type { Group, Host, ImportPreview } from "../lib/types";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon";
import PromptDialog from "./PromptDialog";
import ConfirmDialog from "./ConfirmDialog";
import ImportDialog from "./ImportDialog";
import TerminalContextMenu from "./TerminalContextMenu";

interface Props {
  hosts: Host[];
  groups: Group[];
  /** 最近连接的主机（最多几条），显示在分组树上方 */
  recentHosts: Host[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRefresh: () => void;
  /** 新建主机；传入 groupId 时在表单里预选该分组 */
  onNewHost: (groupId?: number | null) => void;
  onEditHost: (host: Host) => void;
  /** 主机被删除后通知外层（用于关掉对应标签页） */
  onHostDeleted?: (hostId: number) => void;
  /**
   * 搜索时主机列表是筛选后的子集，拖拽排序会打乱未显示主机的顺序，
   * 因此此时禁用主机的拖拽（分组排序不受影响）。
   */
  hostsFiltered?: boolean;
  onError: (msg: string) => void;
}

/** 拖拽中的项目：主机条目或分组头部 */
type DragItem = { kind: "host"; id: number } | { kind: "group"; id: number };

/** 落点位置：目标上方/下方画插入线，inside 表示整行高亮 */
type DropPosition = "before" | "after" | "inside";

/** 当前高亮的落点 */
type DropMark = { key: string; position: DropPosition };

/** 一次按下过程中尚未结束的拖拽 */
type PendingDrag = {
  item: DragItem;
  label: string;
  x0: number;
  y0: number;
  /** 指针当前位置，用于挂载浮动标签时直接就位 */
  x: number;
  y: number;
  active: boolean;
};

/** 命中测试得到的可放置目标 */
type DropHit = {
  key: string;
  position: DropPosition;
  kind: "host" | "grp" | "end";
  groupId: number | null;
  hostId?: number;
};

/** 指针在元素内的纵向位置：上半区插到前面，下半区插到后面 */
function edgeAt(el: HTMLElement, y: number): "before" | "after" {
  const rect = el.getBoundingClientRect();
  return y < rect.top + rect.height / 2 ? "before" : "after";
}

/** 从 data-group-id 读出分组 id；空串表示根层（不属于任何分组） */
function groupIdOf(el: HTMLElement): number | null {
  const raw = el.dataset.groupId;
  return raw ? Number(raw) : null;
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
  recentHosts,
  selectedId,
  onSelect,
  onRefresh,
  onNewHost,
  onEditHost,
  onHostDeleted,
  hostsFiltered = false,
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
  /** 主机右键菜单：位置（视口坐标）与目标主机 */
  const [hostMenu, setHostMenu] = useState<{
    x: number;
    y: number;
    host: Host;
  } | null>(null);

  /** 导入预检结果：非空时弹导入确认框 */
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  /** 导出菜单的位置（视口坐标） */
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(
    null
  );

  /** 选文件 → 预检 → 弹框确认 */
  const startImport = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: "选择要导入的文件",
        filters: [
          { name: "SSH 配置或 JSON", extensions: ["config", "json", "txt"] },
        ],
      });
      if (typeof picked !== "string") return;
      const preview = await api.previewHostImport(picked);
      setImportPreview(preview);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setImportBusy(true);
    try {
      const summary = await api.importHosts(importPreview.path);
      setImportPreview(null);
      onRefresh();
      notify.success(
        `已导入 ${summary.imported} 台主机` +
          (summary.skipped > 0 ? `，跳过 ${summary.skipped} 台重复` : "")
      );
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setImportBusy(false);
    }
  };

  const startExport = async (format: "json" | "sshConfig") => {
    setExportMenu(null);
    try {
      const picked = await saveFileDialog({
        title: "导出主机库（不含密码）",
        defaultPath:
          format === "json" ? "lshell-hosts.json" : "lshell-ssh-config.txt",
        filters:
          format === "json"
            ? [{ name: "JSON", extensions: ["json"] }]
            : [{ name: "SSH 配置", extensions: ["txt", "config"] }],
      });
      if (typeof picked !== "string") return;
      const count = await api.exportHosts(picked, format);
      notify.success(`已导出 ${count} 台主机（不含密码）`);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  // ---------- 拖拽排序（指针事件实现） ----------
  //
  // 不使用 HTML5 drag&drop：Tauri v2 在 Windows 上默认开启 WebView 原生拖放
  // （窗口配置 dragDropEnabled 默认为 true），会拦截 WebView2 内的
  // dragstart/dragover/drop，前端拖拽完全没反应；而关掉它又会破坏文件面板
  // 依赖原生 onDragDropEvent 的「拖文件上传」。所以这里用 pointer 事件自绘拖拽。

  /** 当前被拖动的项目 */
  const [drag, setDrag] = useState<DragItem | null>(null);
  /** 当前高亮的落点 */
  const [drop, setDrop] = useState<DropMark | null>(null);
  /** 跟随指针的浮动标签文字（位置用 ref 直接写，避免每次移动都重渲染） */
  const [ghostLabel, setGhostLabel] = useState("");
  const ghostRef = useRef<HTMLDivElement | null>(null);
  /** 按下后尚未结束的拖拽 */
  const pending = useRef<PendingDrag | null>(null);
  /** 最近一次真实拖拽的结束时间，用于吞掉拖拽后紧跟的 click */
  const dragEndAt = useRef(0);
  /** 侧栏滚动容器：拖到上下边缘时自动滚动 */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 浮动标签的挂载回调：挂载瞬间就摆到指针位置，避免闪到屏幕左上角 */
  const attachGhost = useCallback((el: HTMLDivElement | null) => {
    ghostRef.current = el;
    if (!el) return;
    const p = pending.current;
    el.style.transform = p
      ? `translate3d(${p.x + 14}px, ${p.y + 12}px, 0)`
      : "translate3d(-9999px, -9999px, 0)";
  }, []);

  const markDrop = (key: string, position: DropPosition) => {
    setDrop((prev) =>
      prev && prev.key === key && prev.position === position
        ? prev
        : { key, position }
    );
  };

  /** 该元素的落点位置，用于拼高亮类名 */
  const dropPosition = (key: string) =>
    drop && drop.key === key ? drop.position : null;

  /** 拖拽刚结束后忽略紧随其后的 click，避免误触折叠/连接 */
  const isDragClick = () => performance.now() - dragEndAt.current < 400;

  const commitHosts = async (groupId: number | null, ids: number[]) => {
    try {
      await api.reorderHosts(groupId, ids);
      onRefresh();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const commitGroups = async (ids: number[]) => {
    try {
      await api.reorderGroups(ids);
      onRefresh();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  /** 把拖动的分组插到目标分组的指定一侧 */
  const moveGroup = (
    item: DragItem,
    target: Group,
    position: "before" | "after"
  ) => {
    if (item.kind !== "group" || item.id === target.id) return;
    const order = groups.map((g) => g.id).filter((id) => id !== item.id);
    const idx = order.indexOf(target.id);
    const at = idx < 0 ? order.length : position === "after" ? idx + 1 : idx;
    order.splice(at, 0, item.id);
    void commitGroups(order);
  };

  /**
   * 把拖动的主机插入目标分组的指定位置（跨组时同时改变 groupId）。
   * `targetId` 为 null 表示追加到组尾。
   */
  const moveHost = (
    item: DragItem,
    groupId: number | null,
    targetId: number | null,
    position: "before" | "after" = "before"
  ) => {
    if (item.kind !== "host" || targetId === item.id) return;
    const moved = hosts.find((h) => h.id === item.id);
    if (!moved) return;
    const list = (grouped.get(groupId) ?? []).filter((h) => h.id !== item.id);
    let idx = list.length;
    if (targetId !== null) {
      const at = list.findIndex((h) => h.id === targetId);
      if (at >= 0) idx = position === "after" ? at + 1 : at;
    }
    list.splice(idx, 0, { ...moved, groupId });
    void commitHosts(groupId, list.map((h) => h.id));
  };

  /** 指针位置命中的可放置目标；不在可放置区域时返回 null */
  const hitTest = (x: number, y: number, item: DragItem): DropHit | null => {
    const raw = document.elementFromPoint(x, y) as HTMLElement | null;
    const el = raw?.closest<HTMLElement>("[data-drop-key]");
    if (!el) return null;
    const key = el.dataset.dropKey;
    const kind = el.dataset.dropKind as DropHit["kind"] | undefined;
    if (!key || !kind) return null;
    const groupId = groupIdOf(el);

    if (kind === "host") {
      if (item.kind !== "host") return null;
      const hostId = Number(el.dataset.hostId);
      return { key, position: edgeAt(el, y), kind, groupId, hostId };
    }
    if (kind === "grp") {
      // 主机落点：整行表示「移入本组」；分组落点：只认真实分组，用于同级排序
      if (item.kind === "host") {
        return { key, position: "inside", kind, groupId };
      }
      if (groupId === null) return null;
      return { key, position: edgeAt(el, y), kind, groupId };
    }
    // kind === "end"：组尾落点，只接主机
    if (item.kind !== "host") return null;
    return { key, position: "inside", kind, groupId };
  };

  /** 按落点执行移动 */
  const applyDrop = (item: DragItem, hit: DropHit) => {
    if (item.kind === "host") {
      if (hit.kind === "host" && hit.hostId !== undefined) {
        moveHost(
          item,
          hit.groupId,
          hit.hostId,
          hit.position === "after" ? "after" : "before"
        );
      } else {
        moveHost(item, hit.groupId, null);
      }
      return;
    }
    const target = groups.find((g) => g.id === hit.groupId);
    if (!target) return;
    moveGroup(item, target, hit.position === "after" ? "after" : "before");
  };

  /** 清掉拖拽的所有临时状态 */
  const resetDrag = () => {
    pending.current = null;
    setDrag(null);
    setDrop(null);
    document.body.classList.remove("row-dragging");
  };

  /** 指针按下：记录起点并捕获指针，移动超过阈值才算拖拽 */
  const startRowDrag = (
    e: ReactPointerEvent<HTMLElement>,
    item: DragItem,
    label: string
  ) => {
    if (e.button !== 0) return;
    // 行内的按钮、重命名输入框不参与拖拽
    if ((e.target as HTMLElement).closest("button, input, textarea, select")) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pending.current = {
      item,
      label,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
    };
  };

  /** 指针移动：越过阈值后切换为拖拽，并实时更新落点 */
  const onRowDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = pending.current;
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!p.active) {
      if (Math.abs(e.clientX - p.x0) < 5 && Math.abs(e.clientY - p.y0) < 5) {
        return;
      }
      p.active = true;
      setDrag(p.item);
      setGhostLabel(p.label);
      document.body.classList.add("row-dragging");
    }

    if (ghostRef.current) {
      ghostRef.current.style.transform = `translate3d(${e.clientX + 14}px, ${
        e.clientY + 12
      }px, 0)`;
    }

    const hit = hitTest(e.clientX, e.clientY, p.item);
    if (hit) markDrop(hit.key, hit.position);
    else setDrop(null);

    // 靠近滚动区上下边缘时自动滚动，方便把条目拖到屏外位置
    const scroller = scrollRef.current;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (e.clientY < rect.top + 28) scroller.scrollTop -= 10;
      else if (e.clientY > rect.bottom - 28) scroller.scrollTop += 10;
    }
  };

  /** 指针抬起：命中落点则落库，否则视为普通点击 */
  const onRowDragEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    document.body.classList.remove("row-dragging");
    if (!p.active) {
      // 未越过阈值：交给 onClick / onDoubleClick
      return;
    }
    dragEndAt.current = performance.now();
    setDrag(null);
    setDrop(null);
    const hit = hitTest(e.clientX, e.clientY, p.item);
    if (hit) applyDrop(p.item, hit);
  };

  // 按分组归类；null 这一组就是根层（不属于任何分组）
  const grouped = useMemo(() => {
    const map = new Map<number | null, Host[]>();
    for (const h of hosts) {
      const key = h.groupId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(h);
    }
    return map;
  }, [hosts]);

  /** 根层主机：不属于任何分组，直接展示在分组树下方 */
  const rootHosts = grouped.get(null) ?? [];

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

  /** 复制主机：后端生成不重名的别名，并沿用它后面的位置 */
  const duplicateHost = async (host: Host) => {
    try {
      const created = await api.duplicateHost(host.id);
      onRefresh();
      notify.success(`已复制主机为「${created.alias}」`);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  /**
   * 主机 / 分组行的键盘操作。
   *
   * - ↑ / ↓ / Home / End：在当前可见行之间移动焦点
   * - Enter / Space：主机发起连接，分组折叠或展开
   * - Shift+F10 或菜单键：在行下方弹出与鼠标右键相同的菜单
   */
  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const row = e.currentTarget;
    const rows = Array.from(
      row.closest(".side-scroll")?.querySelectorAll<HTMLElement>("[data-row-key]") ??
        []
    );
    const index = rows.indexOf(row);

    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      e.preventDefault();
      const last = rows.length - 1;
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? last
            : e.key === "ArrowDown"
              ? Math.min(last, index + 1)
              : Math.max(0, index - 1);
      rows[next]?.focus();
      return;
    }

    const kind = row.dataset.rowKind;
    const id = Number(row.dataset.rowId);

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (kind === "grp") toggle(id);
      else if (kind === "host") onSelect(id);
      return;
    }

    if (
      kind === "host" &&
      (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
    ) {
      e.preventDefault();
      const host = hosts.find((h) => h.id === id);
      if (!host) return;
      const rect = row.getBoundingClientRect();
      setHostMenu({ x: rect.left + 24, y: rect.top + rect.height, host });
    }
  };

  const renderHost = (host: Host) => {
    const pos = dropPosition(`host:${host.id}`);

    return (
    <div
      key={host.id}
      className={`host-row ${selectedId === host.id ? "active" : ""} ${
        drag?.kind === "host" && drag.id === host.id ? "dragging" : ""
      } ${pos === "before" ? "drop-before" : pos === "after" ? "drop-after" : ""}`}
      data-drop-key={`host:${host.id}`}
      data-drop-kind="host"
      data-row-key={`host:${host.id}`}
      data-row-kind="host"
      data-row-id={host.id}
      tabIndex={0}
      aria-current={selectedId === host.id}
      aria-label={`${host.alias}，${host.username}@${host.address}:${host.port}`}
      onKeyDown={onRowKeyDown}
      data-host-id={host.id}
      data-group-id={host.groupId ?? ""}
      onPointerDown={
        hostsFiltered
          ? undefined
          : (e) => startRowDrag(e, { kind: "host", id: host.id }, host.alias)
      }
      onPointerMove={onRowDragMove}
      onPointerUp={onRowDragEnd}
      onPointerCancel={resetDrag}
      onLostPointerCapture={resetDrag}
      onContextMenu={(e) => {
        // 右键只弹「复制主机」；阻止 WebView 默认菜单
        e.preventDefault();
        e.stopPropagation();
        setHostMenu({ x: e.clientX, y: e.clientY, host });
      }}
      onDoubleClick={() => {
        if (isDragClick()) return;
        onSelect(host.id);
      }}
      title={`${host.username}@${host.address}:${host.port} · 双击连接 · ${
        hostsFiltered ? "搜索时不可拖拽排序" : "可拖拽移动"
      }`}
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
  };

  const renderGroup = (group: Group, list: Host[]) => {
    const isCollapsed = collapsed.has(group.id);
    const renaming = renamingId === group.id;
    const pos = dropPosition(`grp:${group.id}`);

    return (
      <div key={group.id}>
        <div
          className={`grp-head ${isCollapsed ? "collapsed" : ""} ${
            drag?.kind === "group" && drag.id === group.id ? "dragging" : ""
          } ${
            pos === "inside"
              ? "drop-in"
              : pos === "before"
                ? "drop-before"
                : pos === "after"
                  ? "drop-after"
                  : ""
          }`}
          data-drop-key={`grp:${group.id}`}
          data-drop-kind="grp"
          data-row-key={`grp:${group.id}`}
          data-row-kind="grp"
          data-row-id={group.id}
          tabIndex={0}
          aria-expanded={!isCollapsed}
          aria-label={`分组 ${group.name}，${list.length} 台主机`}
          onKeyDown={onRowKeyDown}
          data-group-id={group.id}
          onClick={() => {
            if (isDragClick()) return;
            toggle(group.id);
          }}
          onPointerDown={(e) =>
            startRowDrag(e, { kind: "group", id: group.id }, group.name)
          }
          onPointerMove={onRowDragMove}
          onPointerUp={onRowDragEnd}
          onPointerCancel={resetDrag}
          onLostPointerCapture={resetDrag}
          title="拖拽调整分组顺序 · 主机可拖入本组"
        >
          <Icon name="chevron-down" className="chev" />
          <span className="sq" style={{ background: groupColor(group.id) }} />
          {renaming ? (
            <input
              className="grp-rename"
              value={draftName}
              autoFocus
              draggable={false}
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
            <span className="name">{group.name}</span>
          )}
          <span className="count">{list.length}</span>
          <span className="row-actions">
            <button
              className="icon-btn"
              title={`在「${group.name}」下新建主机`}
              onClick={(e) => {
                e.stopPropagation();
                onNewHost(group.id);
              }}
            >
              <Icon name="plus" size={12} />
            </button>
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
          </span>
        </div>
        {!isCollapsed && (
          <div className="grp-body">
            {list.map(renderHost)}
            {drag?.kind === "host" && (
              // 组尾落点：拖到最后一台主机下方即追加到本组末尾
              <div
                className={`grp-tail ${
                  dropPosition(`end:${group.id}`) === "inside" ? "active" : ""
                }`}
                data-drop-key={`end:${group.id}`}
                data-drop-kind="end"
                data-group-id={group.id}
              />
            )}
          </div>
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
            onClick={startImport}
            title="导入主机（~/.ssh/config 或 JSON）"
          >
            <Icon name="upload" />
          </button>
          <button
            className="icon-btn"
            onClick={(e) => setExportMenu({ x: e.clientX, y: e.clientY })}
            title="导出主机库（不含密码）"
          >
            <Icon name="download" />
          </button>
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

      <div className="side-scroll" ref={scrollRef}>
        {recentHosts.length > 0 && (
          <div className="recent-block">
            <div className="recent-head">
              <span className="label">最近连接</span>
            </div>
            {recentHosts.map((h) => (
              <button
                key={h.id}
                className={`recent-row${selectedId === h.id ? " active" : ""}`}
                onClick={() => onSelect(h.id)}
                title={`${h.username}@${h.address}:${h.port}`}
              >
                <Icon name="server" size={12} />
                <span className="name">{h.alias}</span>
                <span className="addr">{h.address}</span>
              </button>
            ))}
          </div>
        )}
        {groups.map((g) => renderGroup(g, grouped.get(g.id) ?? []))}

        {/* 根层主机：不属于任何分组，直接展示在分组树下方 */}
        {rootHosts.map(renderHost)}

        {/* 根层落点：拖到这里即移出分组；也作为根层列表的末尾插入位 */}
        {drag?.kind === "host" && (
          <div
            className={`root-drop ${
              dropPosition("root") === "inside" ? "active" : ""
            }`}
            data-drop-key="root"
            data-drop-kind="end"
            data-group-id=""
          >
            <Icon name="chevron-down" size={12} />
            <span>移到根层（不分组）</span>
          </div>
        )}

        {groups.length === 0 && hosts.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: "24px 12px" }}>
            <span className="glyph">
              <Icon name="server" />
            </span>
            <span className="title">还没有主机</span>
            <span className="hint">点击上方「+」添加第一台服务器</span>
          </div>
        )}

      </div>

      {drag && (
        <div ref={attachGhost} className="drag-ghost">
          <Icon name={drag.kind === "group" ? "folder" : "server"} size={12} />
          <span>{ghostLabel}</span>
        </div>
      )}

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
            ` 组内 ${grouped.get(deletingGroup.id)!.length} 台主机会移到根层（不分组）。`}
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

      {hostMenu && (
        <TerminalContextMenu
          x={hostMenu.x}
          y={hostMenu.y}
          onClose={() => setHostMenu(null)}
          items={[
            {
              id: "duplicate",
              label: "复制主机",
              icon: "copy",
              onSelect: () => void duplicateHost(hostMenu.host),
            },
          ]}
        />
      )}

      {exportMenu && (
        <TerminalContextMenu
          x={exportMenu.x}
          y={exportMenu.y}
          onClose={() => setExportMenu(null)}
          items={[
            {
              id: "export-json",
              label: "导出为 JSON（可再导入）",
              icon: "download",
              onSelect: () => void startExport("json"),
            },
            {
              id: "export-ssh",
              label: "导出为 SSH 配置",
              icon: "file",
              onSelect: () => void startExport("sshConfig"),
            },
          ]}
        />
      )}

      {importPreview && (
        <ImportDialog
          preview={importPreview}
          busy={importBusy}
          onCancel={() => setImportPreview(null)}
          onConfirm={confirmImport}
        />
      )}
    </aside>
  );
}
