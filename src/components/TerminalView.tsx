import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
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
import {
  DEFAULT_TERM_FONT_SIZE,
  TERM_FONT_MAX,
  TERM_FONT_MIN,
} from "../lib/layout";
import { getSettings, updateSetting, useSettings } from "../lib/settings";
import { CommandCapture } from "../lib/command-capture";
import { copyText, readClipboardText } from "../lib/clipboard";
import { resolveTheme } from "../lib/app-themes";
import { onThemeChange } from "../lib/theme";
import TerminalSearch from "./TerminalSearch";

/**
 * 同时存活的 WebGL 渲染器上限。
 *
 * 浏览器对 WebGL 上下文有硬上限（通常 16 个），超出后会被强制丢弃，
 * 表现为终端发黑。超过本上限的新终端退回 xterm 默认 DOM 渲染器，
 * 功能不受影响，只是大流量输出时略慢。
 */
const MAX_WEBGL_CONTEXTS = 4;
let webglCount = 0;

/**
 * 终端配色。
 *
 * 终端表面与侧栏 / 状态栏同属一块「面板材质」，所以底色统一取应用色板的
 * bgPanel，而不是各配色自带的 terminal background（那个通常更暗/更纯，会
 * 让终端区域看起来比周围面板深一档）。ANSI 前景色仍用配色自身定义，
 * 可读性由前景色决定。
 * 有背景图时画布透明，由 .term-host 的半透明面板底色透出背景。
 */
function buildTerminalTheme(themeId: string, hasBackground: boolean): ITheme {
  const theme = resolveTheme(themeId);
  return {
    ...theme.terminal,
    background: hasBackground ? "rgba(0,0,0,0)" : theme.app.bgPanel,
  };
}

/**
 * 给旧的自定义字体值补上等宽兜底。
 *
 * 内置选项本身已经带 Consolas / monospace 后备栈；
 * 数据库里可能存着历史自定义值，字体缺失时不能让终端回落到比例字体。
 */
function terminalFontStack(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("monospace") || lower.includes("consolas")) return value;
  return `${value}, Consolas, monospace`;
}

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
  /** 首次见到该主机或指纹变更，需要用户确认 */
  onNeedsTrust?: (info: {
    fingerprint: string;
    algo: string;
    address: string;
    port: number;
    /** 有值时表示指纹变更（旧记录），需要用户「确认更新」 */
    storedFingerprint?: string;
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

  // 当前远端目录，供文件面板定位
  const cwdRef = useRef<string | null>(null);

  // 终端外观设置：字号、字体、光标、回滚均可在设置里调整
  const settings = useSettings();
  // 右键行为用 ref 读取，避免设置变化时重新绑定事件
  const rightClickRef = useRef(settings.terminal.rightClick);
  rightClickRef.current = settings.terminal.rightClick;

  // 全局背景图由 AppBackground 负责渲染，终端只需要知道「要不要透明」
  const hasBackgroundRef = useRef(settings.terminal.backgroundImage !== "");
  hasBackgroundRef.current = settings.terminal.backgroundImage !== "";

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: terminalFontStack(getSettings().terminal.fontFamily),
      fontSize: getSettings().terminal.fontSize,
      lineHeight: 1.4,
      cursorBlink: getSettings().terminal.cursorBlink,
      cursorStyle: getSettings().terminal.cursorStyle,
      scrollback: getSettings().terminal.scrollback,
      // 有背景图时需要画布透明，背景图才能从底下透出来
      allowTransparency: true,
      theme: buildTerminalTheme(
        getSettings().theme,
        getSettings().terminal.backgroundImage !== ""
      ),
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

    // WebGL 渲染器可显著提升大流量输出的性能。
    // 浏览器对同时存活的 WebGL 上下文有数量上限（通常 16 个），
    // 超出后会被强制丢弃，表现为标签发黑。这里主动设上限，
    // 超出的标签退回 xterm 默认的 DOM 渲染器。
    let webgl: WebglAddon | null = null;
    let webglReleased = false;
    const releaseWebgl = () => {
      if (!webgl || webglReleased) return;
      webglReleased = true;
      webglCount = Math.max(0, webglCount - 1);
    };
    if (webglCount < MAX_WEBGL_CONTEXTS) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          releaseWebgl();
        });
        term.loadAddon(addon);
        webgl = addon;
        webglCount += 1;
      } catch {
        // WebGL 不可用时回退到默认渲染器
        webgl = null;
      }
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

    // 主题切换时同步终端配色（「跟随系统」的系统深浅色变化也走这里）
    const unsubscribeTheme = onThemeChange((theme) => {
      term.options.theme = {
        ...theme.terminal,
        background: hasBackgroundRef.current
          ? "rgba(0,0,0,0)"
          : theme.app.bgPanel,
      };
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

        if (outcome.status === "hostKeyChanged") {
          // 指纹变更：同样交给用户确认，绝不静默替换记录
          onStatusRef.current?.("failed", "主机密钥已变更，等待确认更新");
          onNeedsTrustRef.current?.({
            fingerprint: outcome.fingerprint,
            algo: outcome.algo,
            address,
            port,
            storedFingerprint: outcome.storedFingerprint,
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
     * 右键直接粘贴：终端里「右键=粘贴」符合常见终端习惯，
     * 即使有选中文本也保持粘贴（复制走 Ctrl+Shift+C）。
     * 未连接时不做任何操作，剪贴板为空时不产生输入。
     */
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (rightClickRef.current === "none") return;
      if (term.options.disableStdin === true) return;
      void readClipboardText().then((text) => {
        if (text) term.paste(text);
      });
    };

    hostRef.current.addEventListener("contextmenu", onContextMenu);

    /*
     * Ctrl+滚轮缩放字号：一格 1px，范围 8-32。
     * 缩放后重新 fit 行列数，并把偏好持久化（所有终端共用一个字号）。
     */
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = term.options.fontSize ?? DEFAULT_TERM_FONT_SIZE;
      const next = Math.min(
        TERM_FONT_MAX,
        Math.max(TERM_FONT_MIN, cur + (e.deltaY < 0 ? 1 : -1))
      );
      if (next === cur) return;
      term.options.fontSize = next;
      try {
        fit.fit();
      } catch {
        // 窗口尺寸过小时忽略
      }
      void updateSetting("terminal.fontSize", next);
    };

    hostRef.current.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      disposed = true;
      unsubscribeTheme();
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      hostRef.current?.removeEventListener("contextmenu", onContextMenu);
      hostRef.current?.removeEventListener("wheel", onWheel);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      api.disconnectHost(sessionId).catch(() => {
        // 会话可能已断开
      });
      term.dispose();
      releaseWebgl();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      delete (window as unknown as { __lshellTerm?: Terminal }).__lshellTerm;
    };
  }, [hostId, sessionId, address, port]);

  // 外观/终端设置变化：直接改 xterm options，无需重连或重建终端
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const {
      fontFamily,
      fontSize,
      cursorStyle,
      cursorBlink,
      scrollback,
      backgroundImage,
    } = settings.terminal;
    term.options.fontFamily = terminalFontStack(fontFamily);
    term.options.fontSize = fontSize;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.scrollback = scrollback;
    term.options.theme = buildTerminalTheme(
      settings.theme,
      backgroundImage !== ""
    );
    try {
      fitRef.current?.fit();
    } catch {
      // 容器尺寸过小时忽略
    }
  }, [
    settings.terminal.fontFamily,
    settings.terminal.fontSize,
    settings.terminal.cursorStyle,
    settings.terminal.cursorBlink,
    settings.terminal.scrollback,
    settings.terminal.backgroundImage,
    settings.theme,
  ]);

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
    <div
      className="terminal-pane"
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    >
      <div
        ref={hostRef}
        className="terminal-host"
        style={{ position: "absolute", inset: 0 }}
      />

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

    </div>
  );
}
