import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./lib/api";
import type { AppInfo, Group, Host, Tag } from "./lib/types";
import { useTabs, statusDotClass } from "./lib/tabs";
import { useShortcuts, type Shortcut } from "./lib/shortcuts";
import { initTheme, setTheme, type ThemeMode } from "./lib/theme";
import {
  DEFAULT_SFTP_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  LAYOUT_KEYS,
  readBool,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SFTP_MAX,
  SFTP_MIN,
  useStoredNumber,
  writeBool,
} from "./lib/layout";
import { notify, ToastHost } from "./lib/toast";
import TitleBar from "./components/TitleBar";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import Sidebar from "./components/Sidebar";
import HostDialog from "./components/HostDialog";
import TerminalView from "./components/TerminalView";
import HostKeyDialog from "./components/HostKeyDialog";
import SftpPanel from "./components/SftpPanel";
import ForwardPanel from "./components/ForwardPanel";
import ShortcutHelp from "./components/ShortcutHelp";
import AboutDialog from "./components/AboutDialog";
import CommandHistoryPanel from "./components/CommandHistoryPanel";
import Resizer from "./components/Resizer";
import Icon from "./components/Icon";

/** 把宽度限制在区间内 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [hosts, setHosts] = useState<Host[]>([]);
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
  const [sftpCollapsed, setSftpCollapsed] = useState(true);
  const [theme, setThemeMode] = useState<ThemeMode>("dark");
  const [maximized, setMaximized] = useState(false);

  /**
   * 应用元信息（版本、作者）。
   *
   * 兜底值与 Rust 侧一致：浏览器预览环境没有 app_info 命令，
   * 此时不能让标题栏空着。
   */
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: "lshell",
    version: "1.0.0",
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
  const [followCwd, setFollowCwd] = useState(true);
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
  } = useTabs();

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const [h, g, t] = await Promise.all([
        api.listHosts(search),
        api.listGroups(),
        api.listTags(),
      ]);
      setHosts(h);
      setGroups(g);
      setTags(t);
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
      // 主题在首屏渲染前定好，避免闪一下浅色
      const mode = await initTheme();
      setThemeMode(mode);
      // 目录跟踪开关同样在首屏前读出
      setFollowCwd(await readBool(LAYOUT_KEYS.followCwd, true));
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

  /** 主题三态循环：深色 → 浅色 → 跟随系统 */
  const cycleTheme = () => {
    const next: ThemeMode =
      theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setThemeMode(next);
    setTheme(next);
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
      setFollowCwd(next);
      void writeBool(LAYOUT_KEYS.followCwd, next);
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

  // 全局快捷键
  const shortcuts = useMemo<Shortcut[]>(
    () => [
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
      {
        combo: "mod+1",
        description: "切换到第 1 个标签",
        handler: () => {
          const t = tabs[0];
          if (t) setActive(t.id);
        },
      },
      {
        combo: "mod+2",
        description: "切换到第 2 个标签",
        handler: () => {
          const t = tabs[1];
          if (t) setActive(t.id);
        },
      },
      {
        combo: "mod+3",
        description: "切换到第 3 个标签",
        handler: () => {
          const t = tabs[2];
          if (t) setActive(t.id);
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
    } catch {
      // 浏览器预览环境没有窗口 API
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

  return (
    <div className="app">
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
        theme={theme}
        onCycleTheme={cycleTheme}
        onForward={() => setShowForward(true)}
        onShortcuts={() => setShowShortcuts(true)}
        onHistory={() => setShowHistory(true)}
        onAbout={() => setShowAbout(true)}
      />

      <div className="body" style={{ gridTemplateColumns: bodyColumns }}>
        <Sidebar
          hosts={hosts}
          groups={groups}
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
              // 所有标签的终端都保持挂载，只切换显示。
              // 这样切换标签不会断开连接，也不会丢失回滚历史。
              <div
                key={tab.id}
                className="terminal-pane"
                style={{ display: tab.id === activeId ? "block" : "none" }}
              >
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
        />
      </div>

      <StatusBar
        activeTab={activeTab}
        hostCount={hosts.length}
        groupCount={groups.length}
        tagCount={tags.length}
        sessionCount={tabs.length}
      />

      {showEditor && (
        <HostDialog
          host={editing}
          groups={groups}
          tags={tags}
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
          onCancel={() => {
            clearTrustPrompt();
            setStatus(
              trustPrompt.tabId,
              "failed",
              "未信任主机密钥，已取消连接"
            );
          }}
          onTrust={trustAndReconnect}
        />
      )}

      {showForward && (
        <ForwardPanel
          sessionId={activeTab?.id ?? null}
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
    </div>
  );
}
