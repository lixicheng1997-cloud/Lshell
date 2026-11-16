import { useEffect, useRef, useState } from "react";
import {
  api,
  type HostMetrics,
  type MountUsage,
} from "../lib/api";
import { useSettings } from "../lib/settings";
import { statusDotClass, statusText, type Tab } from "../lib/tabs";

interface Props {
  activeTab: Tab | null;
  /** 当前标签所在目录，用于定位所属挂载点 */
  cwd: string | null;
  hostCount: number;
  groupCount: number;
  tagCount: number;
  sessionCount: number;
}

/** 字节速率格式化 */
function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

/** 千字节数格式化（3.1G / 512M / 800K） */
function fmtKb(kb: number): string {
  if (kb < 1024) return `${Math.round(kb)}K`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)}M`;
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

/** 运行时长（秒）→ "3d4h" / "5h12m" / "42m" */
function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** 网速采样间隔 */
const NET_INTERVAL_MS = 2000;
/** 硬件指标每 N 次网速采样取一次（远端要 sleep 0.5 秒，频率放低） */
const METRICS_EVERY_TICKS = 3;
/** 挂载占用刷新间隔：低频轮询，避免频繁执行 df 打扰终端 */
const DISK_INTERVAL_MS = 60_000;
/** 目录未知时的兜底挂载点 */
const ROOT_MOUNT = "/";

/**
 * 找出目录所属的挂载点：按最长前缀匹配（`/mnt/data` 优先于 `/`）。
 * 目录未知时退回根挂载（再退回第一个可用挂载）。
 */
function mountForCwd(
  mounts: MountUsage[],
  cwd: string | null
): MountUsage | null {
  const norm = (m: MountUsage) =>
    m.mount.length > 1 && m.mount.endsWith("/")
      ? m.mount.slice(0, -1)
      : m.mount;

  if (!cwd) {
    return (
      mounts.find((m) => norm(m) === ROOT_MOUNT) ?? mounts[0] ?? null
    );
  }

  let best: MountUsage | null = null;
  let bestLen = -1;
  for (const m of mounts) {
    const mp = norm(m);
    const hit = mp === ROOT_MOUNT || cwd === mp || cwd.startsWith(`${mp}/`);
    if (hit && mp.length > bestLen) {
      best = m;
      bestLen = mp.length;
    }
  }
  // 目录不是绝对路径或没有匹配项时，退回根挂载，保证仍有可用信息
  return best ?? mounts.find((m) => norm(m) === ROOT_MOUNT) ?? mounts[0] ?? null;
}

/**
 * 当前会话的网速与目标主机硬件监控。
 *
 * 网速来自 Rust 侧的终端通道字节计数，按两次采样差值换算；
 * 硬件指标通过 exec 通道在远端执行采集脚本获取，
 * 远端不支持（非 Linux / 禁用 exec）时静默隐藏，不打扰用户。
 */
function SessionMonitor({
  sessionId,
  connected,
  showNet,
  showMetrics,
}: {
  sessionId: string;
  connected: boolean;
  showNet: boolean;
  showMetrics: boolean;
}) {
  const [speed, setSpeed] = useState<{ rx: number; tx: number } | null>(null);
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const lastRef = useRef<{ rxBytes: number; txBytes: number; at: number } | null>(
    null
  );

  useEffect(() => {
    setSpeed(null);
    setMetrics(null);
    lastRef.current = null;
    // 两项都关闭时不必再发起远端轮询
    if (!connected || (!showNet && !showMetrics)) return;

    let tick = 0;
    let cancelled = false;

    const poll = async () => {
      tick += 1;
      try {
        const s = await api.sessionNetStats(sessionId);
        const now = Date.now();
        const last = lastRef.current;
        lastRef.current = { ...s, at: now };
        if (last && now > last.at) {
          const dt = (now - last.at) / 1000;
          setSpeed({
            rx: Math.max(0, (s.rxBytes - last.rxBytes) / dt),
            tx: Math.max(0, (s.txBytes - last.txBytes) / dt),
          });
        }
      } catch {
        // 会话可能已断开，下一轮再试
      }
      if (tick % METRICS_EVERY_TICKS === 1 && showMetrics) {
        try {
          const m = await api.sessionHostMetrics(sessionId);
          if (!cancelled) setMetrics(m);
        } catch {
          if (!cancelled) setMetrics(null);
        }
      }
    };

    void poll();
    const timer = setInterval(poll, NET_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, connected, showNet, showMetrics]);

  if (!connected) return null;

  const memPct =
    metrics && metrics.memTotalKb > 0
      ? Math.round((metrics.memUsedKb / metrics.memTotalKb) * 100)
      : null;

  const detail = metrics
    ? [
        metrics.hostname,
        metrics.os,
        metrics.cpuModel || null,
        metrics.cores > 0 ? `${metrics.cores} 核` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <>
      {showNet && (
        <>
          <span className="sep" />
          <span
            className="sb mono"
            title="SSH 会话终端通道速率（↓ 接收 · ↑ 发送）"
          >
            {speed
              ? `↓ ${fmtRate(speed.rx)} · ↑ ${fmtRate(speed.tx)}`
              : "↓ -- · ↑ --"}
          </span>
        </>
      )}
      {showMetrics && metrics && (
        <span className="sb mono" title={detail}>
          {`CPU ${metrics.cpuPercent}%`}
          {memPct !== null &&
            ` · 内存 ${fmtKb(metrics.memUsedKb)}/${fmtKb(metrics.memTotalKb)}`}
          {metrics.load && ` · 负载 ${metrics.load.split(" ")[0]}`}
          {metrics.uptimeSecs > 0 && ` · 运行 ${fmtUptime(metrics.uptimeSecs)}`}
        </span>
      )}
    </>
  );
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
  cwd,
  hostCount,
  groupCount,
  tagCount,
  sessionCount,
}: Props) {
  const settings = useSettings();
  const tabId = activeTab?.id ?? null;
  const connected = activeTab?.status === "connected";

  // 真实登录用户：连接成功后由远端 whoami 返回；取不到时回落到主机配置
  const [remoteUser, setRemoteUser] = useState<{
    sessionId: string;
    user: string;
  } | null>(null);
  // 挂载占用：按会话 id 归属，切换/断开即失效，避免残留上一个会话的数据
  const [disk, setDisk] = useState<{
    sessionId: string;
    mounts: MountUsage[];
  } | null>(null);
  const [diskOpen, setDiskOpen] = useState(false);

  useEffect(() => {
    setRemoteUser(null);
    if (!tabId || !connected) return;
    let cancelled = false;
    api
      .sessionCurrentUser(tabId)
      .then((user) => {
        if (!cancelled) setRemoteUser({ sessionId: tabId, user });
      })
      .catch(() => {
        // 远端不支持 exec 时保持空，展示回落到主机配置用户名
      });
    return () => {
      cancelled = true;
    };
  }, [tabId, connected]);

  useEffect(() => {
    setDisk(null);
    setDiskOpen(false);
    // 状态栏关闭磁盘项后不再执行 df 轮询
    if (!tabId || !connected || !settings.status.disk) return;
    let cancelled = false;

    const load = async () => {
      try {
        const mounts = await api.sessionDiskUsage(tabId);
        if (!cancelled) setDisk({ sessionId: tabId, mounts });
      } catch {
        // 命令失败/超时：隐藏该项，不保留过期数据
        if (!cancelled) setDisk(null);
      }
    };

    void load();
    const timer = setInterval(load, DISK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tabId, connected, settings.status.disk]);

  const label = activeTab ? statusText(activeTab.status) : null;

  // 已连接优先显示远端真实用户；未连接/取不到时用主机配置的用户名
  const shownUser =
    connected && remoteUser?.sessionId === tabId
      ? remoteUser.user
      : (activeTab?.username ?? "");
  const target = activeTab
    ? `${shownUser ? `${shownUser}@` : ""}${activeTab.address}:${activeTab.port}`
    : "";

  const mounts = connected && disk?.sessionId === tabId ? disk.mounts : null;
  const currentMount = mounts ? mountForCwd(mounts, cwd) : null;
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
          <span className="sb mono">{target}</span>
          {settings.status.disk && currentMount && (
            <>
              <span className="sep" />
              <span
                className="sb disk"
                onMouseEnter={() => setDiskOpen(true)}
                onMouseLeave={() => setDiskOpen(false)}
              >
                <span
                  className="disk-trigger mono"
                  onClick={() => setDiskOpen((v) => !v)}
                  title={`挂载点 ${currentMount.mount} · 点击或悬停查看全部挂载卷`}
                >
                  磁盘 {currentMount.percent}% ({fmtKb(currentMount.usedKb)}/{fmtKb(currentMount.totalKb)})
                </span>
                {diskOpen && mounts && (
                  <div className="disk-pop">
                    <div className="disk-pop-head">挂载卷 · {mounts.length}</div>
                    {mounts.map((m) => (
                      <div
                        key={m.mount}
                        className={`disk-row ${
                          m.mount === currentMount.mount ? "active" : ""
                        }`}
                      >
                        <span className="disk-mount mono" title={m.mount}>
                          {m.mount}
                        </span>
                        <span className="disk-pct mono">{m.percent}%</span>
                        <span className="disk-size mono">
                          {fmtKb(m.usedKb)}/{fmtKb(m.totalKb)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </span>
            </>
          )}
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
          <SessionMonitor
            sessionId={activeTab.id}
            connected={activeTab.status === "connected"}
            showNet={settings.status.net}
            showMetrics={settings.status.metrics}
          />
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
