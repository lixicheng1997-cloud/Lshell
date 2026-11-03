import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  api,
  errorMessage,
  FRAME_CLOSED,
  FRAME_DATA,
  FRAME_STATUS,
  parseNotice,
  type SessionNotice,
} from "../lib/api";
import { CwdScanner } from "../lib/cwd";
import { CommandCapture } from "../lib/command-capture";
import { copyText, pasteText } from "../lib/clipboard";
import { readTerminalTheme } from "../lib/terminal-theme";
import { onThemeChange } from "../lib/theme";
import TerminalSearch from "./TerminalSearch";
import TerminalContextMenu, { type MenuItem } from "./TerminalContextMenu";

interface Props {
  hostId: number;
  sessionId: string;
  address: string;
  port: number;
  /** 是否启用「跟随终端目录」（连接成功后向远端注入上报脚本） */
  trackCwd?: boolean;
  /** 连接失败或状态变化时通知父组件 */
  onStatus?: (
    status: "connecting" | "connected" | "reconnecting" | "failed" | "closed",
    message?: string
  ) => void;
  /** 远端上报当前目录时通知父组件 */
  onCwdChange?: (path: string) => void;
  /** 非致命提示（例如远端不支持目录跟踪） */
  onWarn?: (message: string) => void;
  /** 会话状态变化（断线重连等），父组件可据此弹提示 */
  onNotice?: (notice: SessionNotice) => void;
  /** 首次见到该主机，需要用户确认指纹 */
  onNeedsTrust?: (info: {
    fingerprint: string;
    algo: string;
    address: string;
    port: number;
  }) => void;
  /** 重新连接当前会话 */
  onReconnect?: () => void;
  /** 在文件面板中打开当前远端目录 */
  onOpenSftp?: (path: string | null) => void;
  /** 打开命令历史面板 */
  onOpenHistory?: () => void;
  /** 记录一条已执行的命令 */
  onCommand?: (command: string, cwd: string | null) => void;
  /** 断开当前连接 */
  onDisconnect?: () => void;
}

/**
 * 终端视图。
 *
 * 与 Rust 侧通过 Tauri 二进制通道通信：
 * - 前端 → Rust：用户输入、尺寸变化
 * - Rust → 前端：远端输出、会话结束
 */
export default function TerminalView({
  hostId,
  sessionId,
  address,
  port,
  trackCwd,
  onStatus,
  onCwdChange,
  onWarn,
  onNotice,
  onNeedsTrust,
  onReconnect,
  onOpenSftp,
  onOpenHistory,
  onCommand,
  onDisconnect,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const onStatusRef = useRef(onStatus);
  const onNeedsTrustRef = useRef(onNeedsTrust);
  const onCwdChangeRef = useRef(onCwdChange);
  const onWarnRef = useRef(onWarn);
  const onNoticeRef = useRef(onNotice);
  const onReconnectRef = useRef(onReconnect);
  const onOpenSftpRef = useRef(onOpenSftp);
  const onOpenHistoryRef = useRef(onOpenHistory);
  const onCommandRef = useRef(onCommand);
  const onDisconnectRef = useRef(onDisconnect);
  // 用 ref 读取开关状态：开关变化不应该触发重连
  const trackCwdRef = useRef(trackCwd);
  onStatusRef.current = onStatus;
  onNeedsTrustRef.current = onNeedsTrust;
  onCwdChangeRef.current = onCwdChange;
  onWarnRef.current = onWarn;
  onNoticeRef.current = onNotice;
  onReconnectRef.current = onReconnect;
  onOpenSftpRef.current = onOpenSftp;
  onOpenHistoryRef.current = onOpenHistory;
  onCommandRef.current = onCommand;
  onDisconnectRef.current = onDisconnect;
  trackCwdRef.current = trackCwd;

  // ---------- 终端内搜索 ----------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchMatch, setSearchMatch] = useState({ index: -1, count: 0 });

  // ---------- 右键菜单 ----------
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);

  // 当前远端目录，供「在 SFTP 中打开」使用
  const cwdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 10000,
      theme: readTerminalTheme(),
      // 搜索高亮要用 registerDecoration / registerMarker，
      // 它们属于 xterm 的 proposed API，必须显式开启，否则调用即抛错。
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    // 终端内搜索：支持高亮所有匹配项与匹配计数
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;

    // WebGL 渲染器可显著提升大流量输出的性能
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL 不可用时回退到默认渲染器
    }

    term.open(hostRef.current);
    fit.fit();

    /*
     * 复制 / 粘贴：按 Windows Terminal 的习惯来
     * - Ctrl+C：有选区时复制选中文本（不再把 ^C 发给远端），没有选区时照常中断；
     * - Ctrl+Shift+C：同上，始终只做复制；
     * - Ctrl+V / Ctrl+Shift+V：不拦截，交给浏览器原生 paste 事件，
     *   由 xterm 自己把剪贴板内容写进远端。
     * - Ctrl+Shift+F：打开终端内搜索（与全局的 Ctrl+Shift+F 区分，
     *   终端聚焦时优先用搜索）。
     */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;

      // 终端内搜索：Ctrl+Shift+F
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.code === "KeyF" || e.key.toLowerCase() === "f") {
          setSearchOpen(true);
          return false;
        }
      }

      if (!e.ctrlKey || e.altKey || e.metaKey) return true;
      // 用 code 判断，避免非英文键盘布局下 key 不是 "c"
      if (e.code !== "KeyC" && e.key.toLowerCase() !== "c") return true;

      if (!term.hasSelection()) {
        // 没有选区：Ctrl+Shift+C 不做事，Ctrl+C 继续当作中断
        return !e.shiftKey;
      }

      void copyText(term.getSelection());
      return false;
    });

    termRef.current = term;
    fitRef.current = fit;

    // 暴露实例，便于通过 CDP 调试与自动化测试读取终端缓冲区
    (window as unknown as { __lshellTerm?: Terminal }).__lshellTerm = term;

    // 目录跟踪：扫描远端上报的 OSC 7 序列
    const scanner = new CwdScanner((p) => {
      cwdRef.current = p;
      onCwdChangeRef.current?.(p);
    });

    // 主题切换时同步终端配色（xterm 支持运行时改 theme，无需重连）
    const unsubscribeTheme = onThemeChange(() => {
      term.options.theme = readTerminalTheme();
    });

    // 命令捕获：从输入字节流里还原用户执行的命令
    const capture = new CommandCapture();

    // 用户输入 → Rust
    const inputDisposable = term.onData((data) => {
      // 先尝试捕获命令（回车时产出）
      const command = capture.push(data);
      if (command) {
        onCommandRef.current?.(command, cwdRef.current);
      }

      api
        .terminalWrite(sessionId, Array.from(new TextEncoder().encode(data)))
        .catch((e) => {
          term.writeln(`\r\n[发送失败: ${String(e)}]`);
        });
    });

    // 尺寸变化 → Rust
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      api.terminalResize(sessionId, cols, rows).catch(() => {
        // 尺寸同步失败不打断终端使用
      });
    });

    // 连接
    onStatusRef.current?.("connecting");
    let disposed = false;
    // 状态帧已经解释过「为什么结束」，关闭帧就不再重复提示
    let closedExplained = false;

    const connect = async () => {
      try {
        const outcome = await api.connectHost(hostId, sessionId, (frame) => {
          if (disposed) return;
          const bytes = new Uint8Array(frame);
          if (bytes.length === 0) return;
          // 帧头：0x00 = 数据，0x01 = 会话结束，0x02 = 状态变化
          switch (bytes[0]) {
            case FRAME_DATA:
              // 先扫目录上报，再交给终端渲染
              scanner.push(bytes.subarray(1));
              term.write(bytes.subarray(1));
              break;
            case FRAME_STATUS: {
              const notice = parseNotice(bytes.subarray(1));
              if (!notice) break;
              onNoticeRef.current?.(notice);
              switch (notice.state) {
                case "reconnecting":
                  // 重连期间禁止输入：写往旧连接的字符会被丢弃，
                  // 让用户知道这段时间敲的键盘是不生效的
                  term.options.disableStdin = true;
                  term.writeln(
                    `\r\n\x1b[33m[${notice.message ?? "连接已断开，正在尝试重连"}]\x1b[0m`
                  );
                  onStatusRef.current?.("reconnecting", notice.message);
                  break;
                case "reconnected":
                  term.options.disableStdin = false;
                  term.writeln(
                    `\r\n\x1b[32m[${notice.message ?? "已重新连接"}]\x1b[0m`
                  );
                  // 不带 message：状态栏此时该显示「已连接」，
                  // 残留的提示语会在状态栏里显得像错误
                  onStatusRef.current?.("connected");
                  break;
                case "disconnected":
                  closedExplained = true;
                  term.options.disableStdin = true;
                  term.writeln(
                    `\r\n\x1b[31m[${notice.message ?? "连接已断开"}]\x1b[0m`
                  );
                  onStatusRef.current?.("failed", notice.message);
                  break;
                case "closed":
                  closedExplained = true;
                  term.options.disableStdin = true;
                  onStatusRef.current?.("closed", notice.message);
                  break;
              }
              break;
            }
            case FRAME_CLOSED:
              if (!closedExplained) {
                onStatusRef.current?.("closed");
                term.writeln("\r\n[连接已关闭]");
              }
              break;
          }
        });

        if (disposed) return;

        if (outcome.status === "needsHostKeyTrust") {
          // 首次连接：交给父组件弹指纹确认框，用户确认后重连
          onStatusRef.current?.("failed", "等待确认主机密钥");
          onNeedsTrustRef.current?.({
            fingerprint: outcome.fingerprint,
            algo: outcome.algo,
            address,
            port,
          });
          return;
        }

        onStatusRef.current?.("connected");

        // 目录跟踪：会话就绪后向远端注入上报脚本（幂等，重复调用无副作用）
        if (trackCwdRef.current) {
          api
            .enableCwdTracking(sessionId)
            .catch((e) => onWarnRef.current?.(errorMessage(e)));
        }
      } catch (e) {
        if (disposed) return;
        onStatusRef.current?.("failed", String(e));
        term.writeln(`\r\n[连接失败: ${String(e)}]`);
      }
    };

    connect();

    const onWindowResize = () => {
      try {
        fit.fit();
      } catch {
        // 窗口尺寸过小时忽略
      }
    };
    window.addEventListener("resize", onWindowResize);

    // 标签切换时终端被 display:none 隐藏再显示，尺寸会变化。
    // 用 ResizeObserver 监听容器，尺寸变化时重新 fit。
    let lastSize = { w: 0, h: 0 };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === 0 || height === 0) continue;
        if (width === lastSize.w && height === lastSize.h) continue;
        lastSize = { w: width, h: height };
        onWindowResize();
      }
    });
    observer.observe(hostRef.current);

    /*
     * 右键菜单：拦截终端区域的默认右键，弹出自定义菜单。
     *
     * 菜单项按当前状态动态生成 —— 有无选区、是否已连接，
     * 决定了哪些操作可用。
     */
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();

      const hasSelection = term.hasSelection();
      const connected = term.options.disableStdin !== true;

      const items: MenuItem[] = [
        {
          id: "copy",
          label: "复制",
          icon: "copy",
          shortcut: "Ctrl+Shift+C",
          disabled: !hasSelection,
          onSelect: () => {
            void copyText(term.getSelection());
          },
        },
        {
          id: "paste",
          label: "粘贴",
          icon: "clipboard",
          shortcut: "Ctrl+V",
          disabled: !connected,
          onSelect: () => {
            void pasteText((text) => {
              // 用 paste 事件写进远端，与用户手动 Ctrl+V 一致
              term.paste(text);
            });
          },
        },
        {
          id: "selectAll",
          label: "选择全部",
          disabled: !connected,
          onSelect: () => term.selectAll(),
        },
        {
          id: "search",
          label: "搜索终端输出",
          icon: "search",
          shortcut: "Ctrl+Shift+F",
          onSelect: () => setSearchOpen(true),
        },
        {
          id: "history",
          label: "命令历史",
          icon: "terminal",
          onSelect: () => onOpenHistoryRef.current?.(),
        },
        {
          id: "sftp",
          label: "在文件面板打开当前目录",
          icon: "folder",
          disabled: !connected,
          onSelect: () => onOpenSftpRef.current?.(cwdRef.current),
        },
        {
          id: "reconnect",
          label: "重新连接",
          icon: "refresh",
          onSelect: () => onReconnectRef.current?.(),
        },
        {
          id: "disconnect",
          label: "断开连接",
          icon: "close",
          danger: true,
          disabled: !connected,
          onSelect: () => onDisconnectRef.current?.(),
        },
        {
          id: "clear",
          label: "清屏",
          icon: "trash",
          shortcut: "Ctrl+L",
          onSelect: () => term.clear(),
        },
      ];

      setMenu({ x: e.clientX, y: e.clientY, items });
    };

    hostRef.current.addEventListener("contextmenu", onContextMenu);

    return () => {
      disposed = true;
      unsubscribeTheme();
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      hostRef.current?.removeEventListener("contextmenu", onContextMenu);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      api.disconnectHost(sessionId).catch(() => {
        // 会话可能已断开
      });
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      delete (window as unknown as { __lshellTerm?: Terminal }).__lshellTerm;
    };
  }, [hostId, sessionId, address, port]);

  /** 执行一次搜索；direction 为 1 表示向下，-1 表示向上 */
  const runSearch = useCallback(
    (direction: 1 | -1, query: string, caseSensitive: boolean) => {
      const search = searchRef.current;
      const term = termRef.current;
      if (!search || !term) return;

      if (!query) {
        search.clearDecorations();
        term.clearSelection();
        setSearchMatch({ index: -1, count: 0 });
        return;
      }

      const options = {
        caseSensitive,
        incremental: direction === 1,
        decorations: {
          matchBackground: "#4A4A2A",
          matchBorder: "#7C8CFF",
          matchOverviewRuler: "#7C8CFF",
          activeMatchBackground: "#7C8CFF",
          activeMatchBorder: "#C3CBFF",
          activeMatchColorOverviewRuler: "#F0B429",
        },
      };

      if (direction === 1) search.findNext(query, options);
      else search.findPrevious(query, options);
    },
    []
  );

  // 搜索结果变化时更新计数
  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    const disposable = search.onDidChangeResults((e) => {
      setSearchMatch({ index: e.resultIndex, count: e.resultCount });
    });
    return () => disposable.dispose();
  }, [searchOpen]);

  // 搜索词变化时立即重搜
  useEffect(() => {
    if (!searchOpen) return;
    runSearch(1, searchQuery, searchCaseSensitive);
  }, [searchOpen, searchQuery, searchCaseSensitive, runSearch]);

  // 关闭搜索时清掉高亮
  useEffect(() => {
    if (searchOpen) return;
    searchRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    setSearchMatch({ index: -1, count: 0 });
  }, [searchOpen]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />

      {searchOpen && (
        <TerminalSearch
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onPrev={() => runSearch(-1, searchQuery, searchCaseSensitive)}
          onNext={() => runSearch(1, searchQuery, searchCaseSensitive)}
          onClose={() => setSearchOpen(false)}
          caseSensitive={searchCaseSensitive}
          onCaseSensitiveChange={setSearchCaseSensitive}
          matchIndex={searchMatch.index}
          matchCount={searchMatch.count}
        />
      )}

      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
