import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./lib/api";
import type { UpdateInfo } from "./lib/api";
import { requestUpdateCheck } from "./lib/update";
import type { AppInfo, Group, Host, Tag } from "./lib/types";
import { useTabs, statusDotClass } from "./lib/tabs";
import { useShortcuts, type Shortcut } from "./lib/shortcuts";
import { initSettings, getSettings, updateSetting, useSettings } from "./lib/settings";
import {
  DEFAULT_SFTP_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  LAYOUT_KEYS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SFTP_MAX,
  SFTP_MIN,
  useStoredNumber,
} from "./lib/layout";
import { notify, ToastHost } from "./lib/toast";
import TooltipHost from "./components/Tooltip";
import TitleBar from "./components/TitleBar";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import Sidebar from "./components/Sidebar";
import HostDialog from "./components/HostDialog";
import TerminalView from "./components/TerminalView";
import HostKeyDialog from "./components/HostKeyDialog";
import SftpPanel from "./components/SftpPanel";
import { EditorDialog } from "./components/EditorDialog";
import { EditorSaveDialog, type SaveChoice } from "./components/EditorSaveDialog";
import { useEditorTabs, type EditorTab as EditorTabModel } from "./lib/editorTabs";
import { base64ToBytes, bytesToText, encodeForSave } from "./lib/editor";
import ForwardPanel from "./components/ForwardPanel";
import ShortcutHelp from "./components/ShortcutHelp";
import AboutDialog from "./components/AboutDialog";
import SettingsDialog from "./components/SettingsDialog";
import UpdateDialog from "./components/UpdateDialog";
import TrayHintDialog from "./components/TrayHintDialog";
import CommandHistoryPanel from "./components/CommandHistoryPanel";
import AppBackground from "./components/AppBackground";
import { hasEffectiveBackground } from "./lib/background";
import Resizer from "./components/Resizer";
import TerminalContextMenu from "./components/TerminalContextMenu";
import Icon from "./components/Icon";

/** 首次「关闭到托盘」提示只展示一次 */
const TRAY_HINT_KEY = "lshell.trayHintShown";

/** 把宽度限制在区间内 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [hosts, setHosts] = useState<Host[]>([]);
  /** 最近连接：与搜索结果无关，用于侧栏顶部快捷入口 */
  const [recentHosts, setRecentHosts] = useState<Host[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Host | null>(null);
  /** 新建主机时预选的分组（从分组行右侧的「+」进入） */
  const [newHostGroup, setNewHostGroup] = useState<number | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** 发现的新版本；非空时展示更新提示框 */
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  /** 首次关闭到托盘时的说明 */
  const [trayHint, setTrayHint] = useState(false);
  const [sftpCollapsed, setSftpCollapsed] = useState(true);
  const [maximized, setMaximized] = useState(false);
  /** 全局设置：主题、跟随目录等都由注册表统一提供 */
  const settings = useSettings();

  /**
   * 应用元信息（版本、作者）。
   *
   * 兜底值与 Rust 侧一致：浏览器预览环境没有 app_info 命令，
   * 此时不能让标题栏空着。
   */
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: "lshell",
    version: "1.3.0",
    author: "xichengli",
    description: "Lshell - 轻量级 Windows SSH 客户端",
  });

  // 栏宽可拖拽调整，并持久化
  const [sidebarWidth, setSidebarWidthRaw, persistSidebarWidth] =
    useStoredNumber(LAYOUT_KEYS.sidebarWidth, DEFAULT_SIDEBAR_WIDTH);
  const [sftpWidth, setSftpWidthRaw, persistSftpWidth] = useStoredNumber(
    LAYOUT_KEYS.sftpWidth,
    DEFAULT_SFTP_WIDTH
  );

  // 拖拽过程中用 ref 累加增量：避免依赖上一帧的 state
  const sidebarWidthRef = useRef(sidebarWidth);
  const sftpWidthRef = useRef(sftpWidth);
  const setSidebarWidth = useCallback(
    (n: number) => {
      sidebarWidthRef.current = n;
      setSidebarWidthRaw(n);
    },
    [setSidebarWidthRaw]
  );
  const setSftpWidth = useCallback(
    (n: number) => {
      sftpWidthRef.current = n;
      setSftpWidthRaw(n);
    },
    [setSftpWidthRaw]
  );

  // 异步读回设置后同步 ref
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);
  useEffect(() => {
    sftpWidthRef.current = sftpWidth;
  }, [sftpWidth]);

  // 目录跟踪：开关 + 每个标签上报的当前目录
  const followCwd = settings.followCwd;
  const [cwdMap, setCwdMap] = useState<Record<string, string>>({});

  /**
   * 文件面板的外部跳转请求。
   *
   * 右键菜单「在文件面板打开当前目录」会带上路径，
   * SftpPanel 通过 nonce 变化感知到这是一次新请求（而不是重复渲染）。
   */
  const [sftpJump, setSftpJump] = useState<{ path: string; nonce: number } | null>(
    null
  );

  const {
    tabs,
    activeId,
    trustPrompt,
    openTab,
    closeTab,
    closeTabsByHost,
    renameHost,
    setActive,
    setStatus,
    setTrustPrompt,
    clearTrustPrompt,
    reconnect,
    duplicateTab,
  } = useTabs();

  /** 标签右键菜单：位置（视口坐标）与目标标签 */
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    alias: string;
  } | null>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // ---------- 远程文件编辑 ----------
  const {
    tabs: editorTabs,
    activeId: activeEditorId,
    open: openEditorTab,
    close: closeEditorTab,
    updateSessionId: updateEditorSessionId,
    setActive: setActiveEditor,
  } = useEditorTabs();

  const [saveDialog, setSaveDialog] = useState<{
    kind: "elevate" | "conflict" | "error";
    tab: EditorTabModel;
    remoteText?: string;
    message?: string;
  } | null>(null);
  const [allowSudoPassword, setAllowSudoPassword] = useState(false);

  useEffect(() => {
    api
      .getSetting("editor.allowSudoPassword")
      .then((v) => setAllowSudoPassword(v === "true"))
      .catch(() => {});
  }, []);

  // 重启后恢复的编辑器草稿原本靠页签可见；改为对话框后主动弹出第一份草稿
  useEffect(() => {
    if (!activeEditorId && editorTabs.length > 0) {
      setActiveEditor(editorTabs[0].id);
    }
  }, [activeEditorId, editorTabs, setActiveEditor]);

  // 会话关闭 / 主机删除时清理编辑器；重连换了 tabId 时跟随新的 sessionId
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    for (const et of editorTabs) {
      if (ids.has(et.sessionId)) continue;
      const replacement = tabs.find((t) => t.hostId === et.hostId);
      if (replacement) updateEditorSessionId(et.sessionId, replacement.id);
      else closeEditorTab(et.id);
    }
  }, [tabs, editorTabs, updateEditorSessionId, closeEditorTab]);

  const handleOpenEditor = useCallback(
    async (sessionId: string, path: string) => {
      const host = tabs.find((t) => t.id === sessionId);
      if (!host || host.status !== "connected") {
        notify.error("请先连接该主机再编辑文件");
        return;
      }
      try {
        const meta = await api.editorOpen(sessionId, path);
        openEditorTab({ sessionId, hostId: host.hostId, alias: host.alias, meta });
      } catch (e) {
        notify.error(errorMessage(e));
      }
    },
    [tabs, openEditorTab, notify]
  );

  const performSave = useCallback(
    async (tab: EditorTabModel, choice: SaveChoice) => {
      // 从 store 取最新文本：用户可能在渲染与点击保存之间又输入了内容
      const current =
        useEditorTabs.getState().tabs.find((t) => t.id === tab.id) ?? tab;
      try {
        const content = encodeForSave(current.text, current.meta.eol, current.meta.bom);
        const elevation =
          choice.elevation ??
          (current.meta.needsElevation
            ? ({ mode: "passwordless" } as const)
            : null);
        const result = await api.editorSave(
          current.sessionId,
          current.path,
          content,
          current.baseline,
          { force: choice.force, elevation }
        );
        if (result.status === "conflict") {
          setSaveDialog({
            kind: "conflict",
            tab: current,
            remoteText: bytesToText(base64ToBytes(result.remoteBase64)),
          });
          return;
        }
        // 保存成功后把当前文本记为新的基准，避免关闭时误判为未保存
        useEditorTabs
          .getState()
          .setSaved(current.id, result.baseline, current.text, result.backupPath);
        setSaveDialog(null);
        notify.info(
          result.backupPath ? `已保存，备份：${result.backupPath}` : "已保存"
        );
        if (result.modeWarning) notify.error(result.modeWarning);
        // 保存即关闭当前编辑器标签；若还有其他编辑器，对话框会切到下一份
        closeEditorTab(current.id);
      } catch (e) {
        setSaveDialog({ kind: "error", tab: current, message: errorMessage(e) });
      }
    },
    [notify, closeEditorTab]
  );

  const handleRequestSave = useCallback(
    (tab: EditorTabModel) => {
      if (tab.meta.readOnly && !tab.meta.needsElevation) return;
      if (tab.meta.needsElevation && !tab.meta.readOnly) {
        setSaveDialog({ kind: "elevate", tab });
        return;
      }
      void performSave(tab, {});
    },
    [performSave]
  );

  const handleReloadEditor = useCallback(
    async (tab: EditorTabModel) => {
      try {
        const meta = await api.editorOpen(tab.sessionId, tab.path);
        const text = bytesToText(base64ToBytes(meta.contentBase64));
        useEditorTabs.setState((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tab.id
              ? {
                  ...t,
                  meta,
                  text,
                  savedText: text,
                  baseline: meta.baseline,
                  dirty: false,
                }
              : t
          ),
        }));
        setSaveDialog(null);
      } catch (e) {
        notify.error(errorMessage(e));
      }
    },
    [notify]
  );

  /**
   * 曾经被激活过的标签 id。
   * 恢复的标签在首次切过去之前不挂载终端，因此也不会建立连接。
   */
  const [activated, setActivated] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!activeId) return;
    setActivated((prev) =>
      prev.has(activeId) ? prev : new Set(prev).add(activeId)
    );
  }, [activeId]);

  const refresh = useCallback(async () => {
    try {
      const [h, g, t, r] = await Promise.all([
        api.listHosts(search),
        api.listGroups(),
        api.listTags(),
        api.listRecentHosts(5),
      ]);
      setHosts(h);
      setGroups(g);
      setTags(t);
      setRecentHosts(r);
    } catch (e) {
      notify.error(errorMessage(e));
    }
  }, [search]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch (e) {
        notify.error(errorMessage(e));
      }
      // 全局设置统一走注册表；首屏主题在初始化时已应用，避免闪一下浅色
      await initSettings();
      // 版本号与作者：读不出来时保留兜底值，不阻断启动
      api
        .appInfo()
        .then(setAppInfo)
        .catch(() => {});
      setBooting(false);
    })();
  }, [refresh]);

  useEffect(() => {
    const timer = setTimeout(refresh, 150);
    return () => clearTimeout(timer);
  }, [search, refresh]);

  // 有会话连上时刷新一次侧栏：后端会更新 last_used_at，「最近连接」随之变化
  const connectedCount = tabs.filter((t) => t.status === "connected").length;
  useEffect(() => {
    if (connectedCount > 0) refresh();
  }, [connectedCount, refresh]);

  const trustAndReconnect = async () => {
    const prompt = trustPrompt;
    clearTrustPrompt();
    if (!prompt) return;
    try {
      await api.trustHostKey(
        prompt.address,
        prompt.port,
        prompt.algo,
        prompt.fingerprint
      );
      reconnect(prompt.tabId);
    } catch (e) {
      notify.error(errorMessage(e));
    }
  };

  /** 终端上报当前目录 */
  const handleCwdChange = useCallback((tabId: string, path: string) => {
    setCwdMap((prev) =>
      prev[tabId] === path ? prev : { ...prev, [tabId]: path }
    );
  }, []);

  /**
   * 切换文件面板。
   *
   * 没有任何远程连接时不允许打开：右侧文件面板依赖一个已建立的 SSH 会话，
   * 空会话下展开只会得到一串请求错误。
   */
  const toggleSftp = useCallback(() => {
    if (!activeTab) {
      notify.info("请先在左侧选择主机并连接，再打开文件面板");
      return;
    }
    setSftpCollapsed((c) => !c);
  }, [activeTab]);

  /** 开关「SFTP 跟随终端目录」 */
  const handleFollowChange = useCallback(
    (next: boolean) => {
      updateSetting("followCwd", next);
      if (!next) return;
      // 开启时给已建立的会话补装上报脚本（未连接的会话会在连上后自行安装）
      for (const tab of tabs) {
        api.enableCwdTracking(tab.id).catch(() => {});
      }
    },
    [tabs]
  );

  // 主体三栏的列宽：两侧都可拖拽调整
  const bodyColumns = sftpCollapsed
    ? `${sidebarWidth}px 5px minmax(0, 1fr) 36px`
    : `${sidebarWidth}px 5px minmax(0, 1fr) 5px ${sftpWidth}px`;

  // 窗口最大化状态（用于标题栏按钮的图标切换）
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const check = async () => {
          if (cancelled) return;
          try {
            setMaximized(await win.isMaximized());
          } catch {
            // 非 Tauri 环境忽略
          }
        };
        await check();
        unlisten = await win.onResized(() => {
          check();
        });
      } catch {
        // 浏览器预览环境没有窗口 API
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ---------- 自动更新 ----------

  /**
   * 更新功能的开关只有后端一处（`updater::FEATURE_ENABLED`），
   * 前端启动时读一次。默认 false：开关没读到之前不渲染任何更新入口，
   * 也不会发更新请求。
   */
  const [updateEnabled, setUpdateEnabled] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .updateEnabled()
      .then((enabled) => {
        if (alive) setUpdateEnabled(enabled);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const checkForUpdate = useCallback(async (manual: boolean) => {
    // 与设置页共用同一个检查入口：重复触发会复用同一个请求
    const result = await requestUpdateCheck();
    if (result.status === "available") {
      setUpdateInfo(result.info);
    } else if (manual && result.status === "uptodate") {
      notify.info("当前已是最新版本");
    } else if (manual && result.status === "error") {
      // 静默检查失败（断网、更新源不可达）不打扰用户
      notify.error(result.failure.title);
    }
  }, []);

  // 启动 30 秒后静默检查一次，避开启动阶段的连接与渲染
  useEffect(() => {
    if (!updateEnabled) return;
    const timer = setTimeout(() => checkForUpdate(false), 30_000);
    return () => clearTimeout(timer);
  }, [checkForUpdate, updateEnabled]);

  // 托盘菜单「检查更新」（设置页的按钮直接读全局状态，不再走窗口事件）
  useEffect(() => {
    if (!updateEnabled) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen("update://check", () => checkForUpdate(true));
      } catch {
        // 浏览器预览环境没有事件 API
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [checkForUpdate, updateEnabled]);

  // 自动转发起步失败：后端汇总后一次性通知，避免每条规则弹一次
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{
          sessionId: string;
          failures: {
            localPort: number;
            remoteHost: string;
            remotePort: number;
            message: string;
          }[];
        }>("forward://auto-start-failed", (event) => {
          const failures = event.payload.failures ?? [];
          if (failures.length === 0) return;
          const detail = failures
            .map((f) => `${f.localPort} → ${f.remoteHost}:${f.remotePort}`)
            .join("、");
          notify.error(
            `自动转发启动失败（${failures.length} 项）：${detail}。可在端口转发面板查看详情或更换本地端口。`
          );
        });
      } catch {
        // 浏览器预览环境没有事件 API
      }
    })();
    return () => unlisten?.();
  }, []);

  // ---------- 关闭到托盘 ----------

  /** 托盘是否可用；不可用时关闭窗口必须直接退出，否则窗口藏起来就再也找不回来 */
  const [trayReady, setTrayReady] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .trayAvailable()
      .then((ok) => {
        if (alive) setTrayReady(ok);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          // 不收起时直接放行，窗口正常关闭并退出
          if (!getSettings().behavior.closeToTray) return;
          // 托盘不可用时不隐藏，否则用户无法再唤回窗口
          if (!trayReady) return;

          event.preventDefault();
          // 第一次给一次性说明，用户确认后再隐藏
          if (localStorage.getItem(TRAY_HINT_KEY) !== "1") {
            setTrayHint(true);
            return;
          }
          try {
            await win.hide();
          } catch (e) {
            // 隐藏失败（多半是权限问题）就真正退出，避免「点了关闭没反应」
            notify.error(`收起到托盘失败，正在退出：${errorMessage(e)}`);
            await api.exitApp().catch(() => {});
          }
        });
      } catch {
        // 浏览器预览环境没有窗口 API
      }
    })();
    return () => unlisten?.();
  }, [trayReady]);

  const confirmTrayHint = async () => {
    localStorage.setItem(TRAY_HINT_KEY, "1");
    setTrayHint(false);
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch (e) {
      // 隐藏不了就退出，避免窗口停在原地让用户以为按钮失效
      notify.error(`收起到托盘失败，正在退出：${errorMessage(e)}`);
      await api.exitApp().catch(() => {});
    }
  };

  /** 在当前标签列表里前后循环切换 */
  const cycleTab = (dir: number) => {
    if (tabs.length < 2) return;
    const index = tabs.findIndex((t) => t.id === activeId);
    const next = (Math.max(index, 0) + dir + tabs.length) % tabs.length;
    setActive(tabs[next].id);
  };

  // 全局快捷键
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      // 仅用于快捷键帮助展示、不参与全局注册的条目
      {
        combo: "ctrl+wheel",
        description: "缩放终端",
        hintOnly: true,
        handler: () => {},
      },
      {
        combo: "mod+k",
        description: "聚焦搜索框",
        handler: () => {
          document.querySelector<HTMLInputElement>(".topbar .search")?.focus();
        },
      },
      {
        combo: "mod+n",
        description: "新建主机",
        handler: () => {
          setEditing(null);
          setNewHostGroup(null);
          setShowEditor(true);
        },
      },
      {
        combo: "mod+,",
        description: "打开设置",
        handler: () => setShowSettings(true),
      },
      {
        combo: "mod+w",
        description: "关闭当前标签",
        handler: () => {
          if (activeId) closeTab(activeId);
        },
      },
      {
        combo: "mod+shift+f",
        description: "切换文件面板",
        handler: toggleSftp,
      },
      {
        combo: "mod+shift+t",
        description: "打开端口转发面板",
        handler: () => setShowForward(true),
      },
      {
        combo: "mod+shift+h",
        description: "打开命令历史",
        handler: () => setShowHistory(true),
      },
      // 标签只保留前两个的快捷切换（Ctrl+1 / Ctrl+2）
      ...Array.from({ length: 2 }, (_, i) => ({
        combo: `mod+${i + 1}`,
        description: `切换到第 ${i + 1} 个标签`,
        handler: () => {
          const t = tabs[i];
          if (t) setActive(t.id);
        },
      })),
      {
        combo: "mod+tab",
        description: "切换到下一个标签",
        handler: () => cycleTab(1),
      },
      {
        combo: "mod+shift+tab",
        description: "切换到上一个标签",
        handler: () => cycleTab(-1),
      },
      {
        combo: "mod+q",
        description: "退出 Lshell（等同于托盘菜单的退出）",
        handler: () => {
          api.exitApp().catch(() => {});
        },
      },
    ],
    [tabs, activeId, closeTab, setActive]
  );

  useShortcuts(shortcuts);

  const windowCtl = async (action: "minimize" | "toggle" | "close") => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (action === "minimize") await win.minimize();
      else if (action === "toggle") await win.toggleMaximize();
      else await win.close();
    } catch (e) {
      // 浏览器预览环境没有窗口 API，静默即可；其它情况要让用户看到原因，
      // 避免再次出现「点了关闭没有任何反应」
      if ("__TAURI_INTERNALS__" in window) {
        notify.error(`窗口操作失败：${errorMessage(e)}`);
      }
    }
  };

  if (booting) {
    return (
      <div className="empty" style={{ height: "100%" }}>
        <span className="glyph">
          <Icon name="terminal" />
        </span>
        <span className="title">正在启动…</span>
      </div>
    );
  }

  // 铺背景图时（用户自定义或主题自带插画），面板切换成半透明表面
  const hasBackground = hasEffectiveBackground(settings);

  return (
    <div className={`app ${hasBackground ? "with-bg" : ""}`}>
      <AppBackground />

      <TitleBar
        maximized={maximized}
        version={appInfo.version}
        onMinimize={() => windowCtl("minimize")}
        onToggleMaximize={() => windowCtl("toggle")}
        onClose={() => windowCtl("close")}
      />

      <TopBar
        search={search}
        onSearch={setSearch}
        onForward={() => setShowForward(true)}
        onShortcuts={() => setShowShortcuts(true)}
        onHistory={() => setShowHistory(true)}
        onAbout={() => setShowAbout(true)}
        onSettings={() => setShowSettings(true)}
      />

      <div className="body" style={{ gridTemplateColumns: bodyColumns }}>
        <Sidebar
          hosts={hosts}
          groups={groups}
          recentHosts={search.trim() ? [] : recentHosts}
          selectedId={activeTab?.hostId ?? null}
          onSelect={(id) => {
            const host = hosts.find((h) => h.id === id);
            if (host) openTab(host);
          }}
          onRefresh={refresh}
          onNewHost={(groupId) => {
            setEditing(null);
            setNewHostGroup(groupId ?? null);
            setShowEditor(true);
          }}
          onEditHost={(h) => {
            setEditing(h);
            setShowEditor(true);
          }}
          onHostDeleted={(id) => closeTabsByHost(id)}
          hostsFiltered={search.trim().length > 0}
          onError={notify.error}
        />

        <Resizer
          side="left"
          title="拖动调整主机库宽度 · 双击恢复默认"
          onDelta={(d) =>
            setSidebarWidth(
              clamp(sidebarWidthRef.current + d, SIDEBAR_MIN, SIDEBAR_MAX)
            )
          }
          onCommit={() => persistSidebarWidth(sidebarWidthRef.current)}
          onReset={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
          }}
        />

        <div className="workspace">
          <div className="tabbar">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeId ? "active" : ""}`}
                onClick={() => setActive(tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({
                    x: e.clientX,
                    y: e.clientY,
                    tabId: tab.id,
                    alias: tab.alias,
                  });
                }}
                title={`${tab.alias} — ${tab.address}:${tab.port}`}
              >
                <span className={`sdot ${statusDotClass(tab.status)}`} />
                <span className="name">{tab.alias}</span>
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <Icon name="close" size={9} />
                </span>
              </div>
            ))}
            <div
              className="tab-add"
              onClick={() => {
                setEditing(null);
                setNewHostGroup(null);
                setShowEditor(true);
              }}
              title="新建会话"
            >
              <Icon name="plus" />
            </div>
          </div>

          <div className="term-host">
            {tabs.map((tab) => (
              // 已激活过的标签保持挂载，只切换显示，这样切换标签不会断开连接、
              // 也不会丢失回滚历史。上次退出时留下的标签在首次激活前不挂载，
              // 避免启动瞬间并发建立所有会话。
              <div
                key={tab.id}
                className="terminal-pane"
                style={{ display: tab.id === activeId ? "block" : "none" }}
              >
                {tab.id === activeId || activated.has(tab.id) ? (
                <TerminalView
                  hostId={tab.hostId}
                  sessionId={tab.id}
                  address={tab.address}
                  port={tab.port}
                  trackCwd={followCwd}
                  onStatus={(status, message) =>
                    setStatus(tab.id, status, message)
                  }
                  onCwdChange={(path) => handleCwdChange(tab.id, path)}
                  onWarn={(message) => notify.info(message)}
                  onNotice={(notice) => {
                    // 终端里已经写了这行提示，这里只在状态彻底失败时补一个浮层，
                    // 避免同一条消息在两处重复出现
                    if (notice.state === "disconnected") {
                      notify.error(notice.message ?? "连接已断开");
                    }
                  }}
                  onNeedsTrust={(info) =>
                    setTrustPrompt({ tabId: tab.id, ...info })
                  }
                  onReconnect={() => {
                    // 换 tabId 让 TerminalView 重新挂载，从而重建连接
                    reconnect(tab.id);
                  }}
                  onOpenSftp={(path) => {
                    // 展开文件面板并跳到终端当前目录
                    setSftpCollapsed(false);
                    if (path) {
                      setSftpJump({ path, nonce: Date.now() });
                    }
                  }}
                  onOpenHistory={() => setShowHistory(true)}
                  onCommand={(command, cwd) => {
                    // 命令历史开关关闭后不再写入新记录
                    if (!getSettings().history.enabled) return;
                    api
                      .recordCommand(tab.hostId, command, cwd ?? "")
                      .catch((e) => {
                        // 历史记录失败不该打扰用户
                        console.warn("记录命令历史失败", errorMessage(e));
                      });
                  }}
                  onDisconnect={() => {
                    void api.disconnectHost(tab.id).catch(() => {
                      // 会话可能已断开
                    });
                    setStatus(tab.id, "closed", "已断开连接");
                  }}
                />
                ) : (
                  <div className="term-paused">
                    <Icon name="terminal" size={22} />
                    <span className="title">{tab.alias}</span>
                    <span className="hint">
                      未连接 · 切换到此标签时自动连接
                    </span>
                  </div>
                )}
              </div>
            ))}
            {tabs.length === 0 && (
              <div className="empty">
                <span className="glyph">
                  <Icon name="terminal" />
                </span>
                <span className="title">选择左侧主机以打开终端</span>
                <span className="hint">
                  双击主机条目可编辑配置 · 新建主机请按 Ctrl+N
                </span>
              </div>
            )}
          </div>
        </div>

        {!sftpCollapsed && (
          <Resizer
            side="right"
            title="拖动调整文件面板宽度 · 双击恢复默认"
            onDelta={(d) =>
              setSftpWidth(clamp(sftpWidthRef.current + d, SFTP_MIN, SFTP_MAX))
            }
            onCommit={() => persistSftpWidth(sftpWidthRef.current)}
            onReset={() => {
              setSftpWidth(DEFAULT_SFTP_WIDTH);
              persistSftpWidth(DEFAULT_SFTP_WIDTH);
            }}
          />
        )}

        <SftpPanel
          sessionId={activeTab?.id ?? ""}
          collapsed={sftpCollapsed}
          onToggle={toggleSftp}
          cwd={activeTab ? (cwdMap[activeTab.id] ?? null) : null}
          follow={followCwd}
          onFollowChange={handleFollowChange}
          onError={notify.error}
          jumpTo={sftpJump}
          status={activeTab?.status ?? null}
          onEditFile={(path) => {
            if (activeTab) void handleOpenEditor(activeTab.id, path);
          }}
        />
      </div>

      <StatusBar
        activeTab={activeTab}
        cwd={activeTab ? (cwdMap[activeTab.id] ?? null) : null}
        hostCount={hosts.length}
        groupCount={groups.length}
        tagCount={tags.length}
        sessionCount={tabs.length}
      />

      <EditorDialog
        tabs={editorTabs}
        activeId={activeEditorId}
        sessionStatus={(id) =>
          tabs.find((t) => t.id === id)?.status ?? "closed"
        }
        onSelect={setActiveEditor}
        onClose={closeEditorTab}
        onRequestSave={handleRequestSave}
        blocked={saveDialog !== null}
      />

      {saveDialog && (
        <EditorSaveDialog
          kind={saveDialog.kind}
          tab={saveDialog.tab}
          remoteText={saveDialog.remoteText}
          message={saveDialog.message}
          allowPassword={allowSudoPassword}
          onConfirm={(choice) => void performSave(saveDialog.tab, choice)}
          onReload={() => void handleReloadEditor(saveDialog.tab)}
          onCancel={() => setSaveDialog(null)}
        />
      )}

      {tabMenu && (
        <TerminalContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          items={[
            {
              id: "reconnect",
              label: "重新连接",
              icon: "refresh",
              onSelect: () => reconnect(tabMenu.tabId),
            },
            {
              id: "duplicate",
              label: "复制会话",
              icon: "copy",
              onSelect: () => duplicateTab(tabMenu.tabId),
            },
            {
              id: "close",
              label: "关闭会话",
              icon: "close",
              onSelect: () => closeTab(tabMenu.tabId),
            },
          ]}
        />
      )}

      {showEditor && (
        <HostDialog
          host={editing}
          groups={groups}
          tags={tags}
          hosts={hosts}
          defaultGroupId={newHostGroup}
          onClose={() => {
            setShowEditor(false);
            setNewHostGroup(null);
          }}
          onSaved={(id, alias) => {
            setShowEditor(false);
            setEditing(null);
            refresh();
            // 改名后同步已打开标签的标题
            renameHost(id, alias);
            notify.success("主机已保存");
          }}
        />
      )}

      {trustPrompt && (
        <HostKeyDialog
          fingerprint={trustPrompt.fingerprint}
          algo={trustPrompt.algo}
          host={trustPrompt.address}
          port={trustPrompt.port}
          storedFingerprint={trustPrompt.storedFingerprint}
          onCancel={() => {
            clearTrustPrompt();
            setStatus(
              trustPrompt.tabId,
              "failed",
              trustPrompt.storedFingerprint
                ? "主机密钥已变更，未确认更新，已取消连接"
                : "未信任主机密钥，已取消连接"
            );
          }}
          onTrust={trustAndReconnect}
        />
      )}

      {showForward && (
        <ForwardPanel
          sessionId={activeTab?.id ?? null}
          hostId={activeTab?.hostId ?? null}
          connected={activeTab?.status === "connected"}
          onClose={() => setShowForward(false)}
          onError={notify.error}
        />
      )}

      {showShortcuts && (
        <ShortcutHelp
          shortcuts={shortcuts}
          onClose={() => setShowShortcuts(false)}
        />
      )}

      {showAbout && (
        <AboutDialog info={appInfo} onClose={() => setShowAbout(false)} />
      )}

      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          updateEnabled={updateEnabled}
          // 保持在设置弹层之上打开更新弹层：关闭更新后还能回到检查结果
          onShowUpdate={(info) => setUpdateInfo(info)}
        />
      )}

      {updateEnabled && updateInfo && (
        <UpdateDialog info={updateInfo} onClose={() => setUpdateInfo(null)} />
      )}

      {trayHint && <TrayHintDialog onConfirm={confirmTrayHint} />}

      {showHistory && (
        <CommandHistoryPanel
          hostId={activeTab?.hostId ?? null}
          aliases={Object.fromEntries(hosts.map((h) => [h.id, h.alias]))}
          onClose={() => setShowHistory(false)}
          onRun={(command) => {
            // 把命令送回当前会话并回车执行
            const sessionId = activeTab?.id;
            if (!sessionId) {
              notify.info("没有活动的会话");
              return;
            }
            const bytes = Array.from(
              new TextEncoder().encode(`${command}\r`)
            );
            api.terminalWrite(sessionId, bytes).catch((e) => {
              notify.error(errorMessage(e));
            });
            setShowHistory(false);
          }}
          onError={notify.error}
        />
      )}

      <ToastHost />
      <TooltipHost />
    </div>
  );
}
