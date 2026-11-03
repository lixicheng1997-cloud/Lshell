import { statusDotClass, statusText, type Tab } from "../lib/tabs";

interface Props {
  activeTab: Tab | null;
  hostCount: number;
  groupCount: number;
  tagCount: number;
  sessionCount: number;
}

/** 状态点：颜色与光晕环共同表意，色弱用户也能靠形状区分 */
function StatusDot({ status }: { status: Tab["status"] }) {
  return <span className={`sdot ${statusDotClass(status)}`} />;
}

/**
 * 底部状态栏。
 *
 * 左：当前会话状态与地址；右：全局计数与终端参数。
 */
export default function StatusBar({
  activeTab,
  hostCount,
  groupCount,
  tagCount,
  sessionCount,
}: Props) {
  const label = activeTab ? statusText(activeTab.status) : null;

  // 状态色：绿=已连接、黄=进行中、红=失败，其余用弱化色
  const stateColor = !activeTab
    ? "var(--fg-muted)"
    : activeTab.status === "connected"
      ? "var(--ok)"
      : activeTab.status === "failed"
        ? "var(--err)"
        : activeTab.status === "connecting" || activeTab.status === "reconnecting"
          ? "var(--warn)"
          : "var(--fg-muted)";

  return (
    <div className="statusbar">
      {activeTab ? (
        <>
          <span className="sb">
            <StatusDot status={activeTab.status} />
            <span style={{ color: stateColor, fontWeight: 600 }}>{label}</span>
          </span>
          <span className="sep" />
          <span className="sb mono">
            root@{activeTab.address}:{activeTab.port}
          </span>
          {activeTab.error && (
            <>
              <span className="sep" />
              <span
                className="sb"
                style={{
                  color:
                    activeTab.status === "reconnecting"
                      ? "var(--warn)"
                      : "var(--err)",
                }}
              >
                {activeTab.error}
              </span>
            </>
          )}
        </>
      ) : (
        <>
          <span className="sb">主机 {hostCount}</span>
          <span className="sb">分组 {groupCount}</span>
          <span className="sb">标签 {tagCount}</span>
        </>
      )}

      <div className="spacer" />

      <span className="sb">会话 {sessionCount}</span>
      <span className="sep" />
      <span className="sb mono">UTF-8</span>
      <span className="sb mono">xterm-256color</span>
    </div>
  );
}
