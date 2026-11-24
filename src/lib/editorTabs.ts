/**
 * 远程文件编辑器的标签状态。
 *
 * 与 tabs.ts 刻意分开：tabs.ts 的 Tab.id 就是 Rust 侧的 SSH sessionId，
 * 而编辑器标签不建立独立连接，只引用某个会话标签的 id。
 * 把两者混成 union 会污染会话状态机与持久化语义（见设计文档 §2.3）。
 */

import { create } from "zustand";
import type { EditorBaseline, OpenMeta } from "./api";
import { base64ToBytes, bytesToText } from "./editor";

export interface EditorTab {
  id: string;
  /** 宿主 SSH 会话标签 id（即 Rust 侧 sessionId） */
  sessionId: string;
  hostId: number;
  alias: string;
  path: string;
  name: string;
  meta: OpenMeta;
  text: string;
  /** 最近一次读取/保存成功时的内容，是 dirty 与关闭确认的唯一比对基准 */
  savedText: string;
  baseline: EditorBaseline;
  dirty: boolean;
  loading: boolean;
  error?: string;
}

interface EditorTabState {
  tabs: EditorTab[];
  activeId: string | null;
  open: (input: {
    sessionId: string;
    hostId: number;
    alias: string;
    meta: OpenMeta;
  }) => void;
  close: (id: string) => void;
  /** 宿主会话关闭 / 主机删除时联动关闭 */
  closeBySession: (sessionId: string) => void;
  /** 会话重连会更换 tabId，编辑器必须跟随，否则保存时找不到会话 */
  updateSessionId: (oldId: string, newId: string) => void;
  setActive: (id: string | null) => void;
  setText: (id: string, text: string) => void;
  setSaved: (
    id: string,
    baseline: EditorBaseline,
    savedText: string,
    backupPath?: string | null
  ) => void;
  setStatus: (id: string, status: { loading?: boolean; error?: string }) => void;
}

const STORAGE_KEY = "lshell.editor_tabs";
let seq = 0;
const nextId = () => `editor-${++seq}-${Date.now()}`;

interface PersistedEditorTab {
  sessionId: string;
  hostId: number;
  alias: string;
  meta: Omit<OpenMeta, "contentBase64">;
  text: string;
  savedText?: string;
  baseline: EditorBaseline;
  dirty: boolean;
}

function persist(tabs: EditorTab[]) {
  try {
    const data: PersistedEditorTab[] = tabs.map((t) => ({
      sessionId: t.sessionId,
      hostId: t.hostId,
      alias: t.alias,
      // 内容已经存进 text，不再重复保存 base64
      meta: { ...t.meta, contentBase64: "" },
      text: t.text,
      savedText: t.savedText ?? t.text,
      baseline: t.baseline,
      dirty: t.dirty,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 超出配额或存储不可用时静默放弃，只损失「重启恢复草稿」能力
  }
}

function restore(): EditorTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as PersistedEditorTab[];
    return data.map((t) => ({
      id: nextId(),
      sessionId: t.sessionId,
      hostId: t.hostId,
      alias: t.alias,
      path: t.meta.path,
      name: t.meta.path.split("/").pop() || t.meta.path,
      meta: { ...t.meta, contentBase64: "" },
      text: t.text,
      savedText: t.savedText ?? t.text,
      baseline: t.baseline,
      dirty: t.dirty,
      loading: false,
    }));
  } catch {
    return [];
  }
}

export const useEditorTabs = create<EditorTabState>((set) => ({
  tabs: restore(),
  activeId: null,

  open: ({ sessionId, hostId, alias, meta }) =>
    set((state) => {
      // 同一会话 + 同一路径只打开一个编辑器
      const existing = state.tabs.find(
        (t) => t.sessionId === sessionId && t.meta.path === meta.path
      );
      if (existing) return { activeId: existing.id };

      const savedText = meta.contentBase64
        ? bytesToText(base64ToBytes(meta.contentBase64))
        : "";
      const tab: EditorTab = {
        id: nextId(),
        sessionId,
        hostId,
        alias,
        path: meta.path,
        name: meta.path.split("/").pop() || meta.path,
        meta,
        text: "",
        savedText,
        baseline: meta.baseline,
        dirty: false,
        loading: true,
      };
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }),

  close: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      let activeId = state.activeId;
      if (activeId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      return { tabs, activeId };
    }),

  closeBySession: (sessionId) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.sessionId !== sessionId);
      if (tabs.length === state.tabs.length) return state;
      const activeStillThere = tabs.some((t) => t.id === state.activeId);
      return {
        tabs,
        activeId: activeStillThere ? state.activeId : (tabs[0]?.id ?? null),
      };
    }),

  updateSessionId: (oldId, newId) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.sessionId === oldId ? { ...t, sessionId: newId } : t
      ),
    })),

  setActive: (activeId) => set({ activeId }),

  setText: (id, text) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              text,
              // 以「已保存内容」为准：改回原样后自动清除脏标记
              dirty: t.loading ? t.dirty : text !== t.savedText,
            }
          : t
      ),
    })),

  setSaved: (id, baseline, savedText) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, baseline, savedText, text: savedText, dirty: false } : t
      ),
    })),

  setStatus: (id, status) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              loading: status.loading ?? t.loading,
              error: status.error,
            }
          : t
      ),
    })),
}));

useEditorTabs.subscribe((state) => persist(state.tabs));

/** 是否还有未保存的编辑器（退出确认用） */
export function hasUnsavedEditorTabs(): boolean {
  return useEditorTabs.getState().tabs.some((t) => t.dirty);
}
