import Brand from "./Brand";

interface Props {
  /** 窗口是否为最大化状态 */
  maximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

/**
 * 自绘标题栏。
 *
 * 品牌与版本号在这里，与下方功能顶栏分离 —— 旧版把两者挤在同一行，
 * 是「网页感」的根源。
 */
export default function TitleBar({
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: Props) {
  return (
    // deep：整条标题栏空白处都可拖动，按钮自身不贴属性因而不会误触发拖动
    <div className="titlebar" data-tauri-drag-region="deep">
      <div className="brand">
        <Brand height={16} className="logo" />
        <span className="ver">1.0.0</span>
      </div>

      <div className="spacer" />

      <div className="win-ctl">
        <button onClick={onMinimize} title="最小化" aria-label="最小化">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          onClick={onToggleMaximize}
          title={maximized ? "向下还原" : "最大化"}
          aria-label={maximized ? "向下还原" : "最大化"}
        >
          {maximized ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
              <path d="M8 8V6a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-2" />
              <rect x="4" y="8" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          )}
        </button>
        <button className="close" onClick={onClose} title="关闭" aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
