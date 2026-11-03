import { create } from "zustand";
import type { Host } from "./types";

/**
 * 会话标签的状态管理。
 *
 * 每个标签对应一条独立的 SSH 会话，Rust 侧以 sessionId 区分。
 */

/** 标签状态 */
export type TabStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";

export interface Tab {
  /** 唯一标识，同时作为 Rust 侧会话的 key */
  id: string;
  hostId: number;
  alias: string;
  address: string;
  port: number;
  status: TabStatus;
  error?: string;
}

interface TabState {
  tabs: Tab[];
  activeId: string | null;
  /** 首次见到某主机时的指纹确认 */
  trustPrompt: {
    tabId: string;
    fingerprint: string;
    algo: string;
    address: string;
    port: number;
  } | null;

  openTab: (host: Host) => void;
  closeTab: (id: string) => void;
  closeOthers: (id: string) => void;
  /** 关掉某台主机的全部标签（主机被删除时调用） */
  closeTabsByHost: (hostId: number) => void;
  /** 主机改名后同步标签标题 */
  renameHost: (hostId: number, alias: string) => void;
  setActive: (id: string) => void;
  setStatus: (
    id: string,
    status: TabStatus,
    error?: string
  ) => void;
  setTrustPrompt: (
    prompt: TabState["trustPrompt"]
  ) => void;
  clearTrustPrompt: () => void;
  /** 信任主机密钥后重连：改变 tabId 强制组件重挂载 */
  reconnect: (tabId: string) => void;
}

let seq = 0;
const nextId = () => `tab-${++seq}-${Date.now()}`;

/**
 * 状态点样式类。
 *
 * 颜色与光晕环共同表意，色弱用户也能靠形状区分：
 * 绿=已连接、黄+呼吸=进行中（连接中/重连中）、红=失败、灰=断开。
 */
export function statusDotClass(status: TabStatus): string {
  switch (status) {
    case "connected":
      return "ok";
    case "failed":
      return "err";
    case "connecting":
    case "reconnecting":
      return "warn pulse";
    default:
      return "idle";
  }
}

/** 状态点的文字标签 */
export function statusText(status: TabStatus): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "reconnecting":
      return "重连中";
    case "failed":
      return "连接失败";
    default:
      return "已断开";
  }
}

export const useTabs = create<TabState>((set) => ({
  tabs: [],
  activeId: null,
  trustPrompt: null,

  openTab: (host) =>
    set((state) => {
      // 同一主机已开标签则直接激活，不重复连接
      const existing = state.tabs.find((t) => t.hostId === host.id);
      if (existing) {
        return { activeId: existing.id };
      }
      const tab: Tab = {
        id: nextId(),
        hostId: host.id,
        alias: host.alias,
        address: host.address,
        port: host.port,
        status: "connecting",
      };
      return {
        tabs: [...state.tabs, tab],
        activeId: tab.id,
      };
    }),

  closeTab: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      let activeId = state.activeId;
      if (activeId === id) {
        // 关闭后激活相邻标签
        const idx = state.tabs.findIndex((t) => t.id === id);
        activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      return { tabs, activeId };
    }),

  closeOthers: (id) =>
    set((state) => ({
      tabs: state.tabs.filter((t) => t.id === id),
      activeId: id,
    })),

  closeTabsByHost: (hostId) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.hostId !== hostId);
      if (tabs.length === state.tabs.length) return state;
      const activeStillThere = tabs.some((t) => t.id === state.activeId);
      return {
        tabs,
        activeId: activeStillThere ? state.activeId : (tabs[0]?.id ?? null),
      };
    }),

  renameHost: (hostId, alias) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.hostId === hostId ? { ...t, alias } : t
      ),
    })),

  setActive: (id) => set({ activeId: id }),

  setStatus: (id, status, error) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, status, error } : t
      ),
    })),

  setTrustPrompt: (trustPrompt) => set({ trustPrompt }),

  clearTrustPrompt: () => set({ trustPrompt: null }),

  reconnect: (tabId) =>
    set((state) => ({
      // 换 id 让 React 重新挂载 TerminalView，触发重连
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, id: nextId(), status: "connecting" } : t
      ),
    })),
}));
