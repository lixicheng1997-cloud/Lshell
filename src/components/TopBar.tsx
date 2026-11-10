import Icon from "./Icon";

interface Props {
  search: string;
  onSearch: (v: string) => void;
  onForward: () => void;
  onShortcuts: () => void;
  onHistory: () => void;
  onAbout: () => void;
  onSettings: () => void;
}

/**
 * 功能顶栏。
 *
 * 只承载「可操作的东西」：搜索、转发、历史、快捷键、关于、设置。
 * 新建主机放在侧栏标题行，这里不再重复一个入口。
 */
export default function TopBar({
  search,
  onSearch,
  onForward,
  onShortcuts,
  onHistory,
  onAbout,
  onSettings,
}: Props) {
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

      {/* 右上角动作组：只保留图标，中文名走统一的气泡提示 */}
      <div className="topbar-actions">
        <button
          className="btn icon"
          data-tip="端口转发 (Ctrl+Shift+T)"
          aria-label="端口转发"
          onClick={onForward}
        >
          <Icon name="port-forward" />
        </button>

        <button
          className="btn icon"
          data-tip="命令历史 (Ctrl+Shift+H)"
          aria-label="命令历史"
          onClick={onHistory}
        >
          <Icon name="terminal" />
        </button>

        <button
          className="btn icon"
          data-tip="快捷键"
          aria-label="快捷键"
          onClick={onShortcuts}
        >
          <Icon name="keyboard" />
        </button>

        <button
          className="btn icon"
          data-tip="关于 Lshell"
          aria-label="关于 Lshell"
          onClick={onAbout}
        >
          <Icon name="info" />
        </button>

        <button
          className="btn icon"
          data-tip="设置 (Ctrl+,)"
          aria-label="设置"
          onClick={onSettings}
        >
          <Icon name="settings" />
        </button>
      </div>
    </div>
  );
}
