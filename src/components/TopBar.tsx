import Icon from "./Icon";
import type { ThemeMode } from "../lib/theme";

interface Props {
  search: string;
  onSearch: (v: string) => void;
  theme: ThemeMode;
  onCycleTheme: () => void;
  onForward: () => void;
  onShortcuts: () => void;
  onHistory: () => void;
  onAbout: () => void;
}

/**
 * 功能顶栏。
 *
 * 只承载「可操作的东西」：搜索、转发、历史、快捷键、关于、主题。
 * 新建主机放在侧栏标题行，这里不再重复一个入口。
 */
export default function TopBar({
  search,
  onSearch,
  theme,
  onCycleTheme,
  onForward,
  onShortcuts,
  onHistory,
  onAbout,
}: Props) {
  const themeIcon =
    theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor";
  const themeLabel =
    theme === "dark" ? "深色" : theme === "light" ? "浅色" : "跟随系统";

  return (
    <div className="topbar">
      <label className="omni">
        <input
          className="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="搜索主机、地址，或 tag:生产"
          spellCheck={false}
        />
      </label>

      <div className="spacer" />

      <button className="btn" onClick={onForward} title="端口转发 (Ctrl+Shift+T)">
        <Icon name="port-forward" />
        转发
      </button>

      <button className="btn" onClick={onHistory} title="命令历史 (Ctrl+Shift+H)">
        <Icon name="terminal" />
        历史
      </button>

      <button className="btn" onClick={onShortcuts} title="快捷键">
        <Icon name="keyboard" />
        快捷键
      </button>

      <button className="btn" onClick={onAbout} title="关于 Lshell">
        <Icon name="info" />
        关于
      </button>

      <button
        className="btn"
        onClick={onCycleTheme}
        title={`主题：${themeLabel}（点击切换）`}
      >
        <Icon name={themeIcon} />
      </button>
    </div>
  );
}
