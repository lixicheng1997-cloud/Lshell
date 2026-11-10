import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type ForwardRuntime } from "../lib/api";
import { useDialogFocus } from "../lib/dialog";
import type { Forward } from "../lib/types";
import Icon from "./Icon";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  sessionId: string | null;
  hostId: number | null;
  /** 当前会话是否已连上：未连上时只能编辑规则，不能启动监听 */
  connected: boolean;
  onClose: () => void;
  onError: (msg: string) => void;
}

/** 端口输入校验：必须是 1-65535 的整数 */
function parsePort(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * 端口转发管理面板。
 *
 * 规则按主机持久化；勾选「自动」的规则会在每次连接建立后由后端自动启动。
 * 运行中的监听跟随当前会话，关闭标签即停止。
 */
export default function ForwardPanel({
  sessionId,
  hostId,
  connected,
  onClose,
  onError,
}: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();
  /** 持久化的规则 */
  const [rules, setRules] = useState<Forward[]>([]);
  /** 当前会话运行中的监听 */
  const [runtime, setRuntime] = useState<ForwardRuntime[]>([]);
  const [localPort, setLocalPort] = useState("8080");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("80");
  const [autoStart, setAutoStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Forward | null>(null);

  const refreshRules = useCallback(async () => {
    if (!hostId) {
      setRules([]);
      return;
    }
    try {
      setRules(await api.listForwards(hostId));
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [hostId, onError]);

  const refreshRuntime = useCallback(async () => {
    if (!sessionId || !connected) {
      setRuntime([]);
      return;
    }
    try {
      setRuntime(await api.forwardList(sessionId));
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [sessionId, connected, onError]);

  useEffect(() => {
    void refreshRules();
  }, [refreshRules]);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const isRunning = (port: number) =>
    runtime.some((r) => r.localPort === port);

  const saveRule = async () => {
    if (!hostId) return;
    const lp = parsePort(localPort);
    if (!lp) return onError("本地端口无效（1-65535）");
    const rp = parsePort(remotePort);
    if (!rp) return onError("远端端口无效（1-65535）");
    const rh = remoteHost.trim();
    if (!rh) return onError("远端地址不能为空");

    setBusy(true);
    try {
      await api.saveForward(hostId, {
        id: 0,
        hostId,
        localPort: lp,
        remoteHost: rh,
        remotePort: rp,
        autoStart,
      });
      await refreshRules();
      // 已连接时顺带启动，省掉「保存后再点一次启动」
      if (connected && sessionId && !isRunning(lp)) {
        await api.forwardStart(sessionId, lp, rh, rp);
        await refreshRuntime();
      }
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (rule: Forward) => {
    try {
      await api.saveForward(rule.hostId, {
        ...rule,
        autoStart: !rule.autoStart,
      });
      await refreshRules();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const start = async (rule: Forward) => {
    if (!sessionId) return;
    try {
      await api.forwardStart(
        sessionId,
        rule.localPort,
        rule.remoteHost,
        rule.remotePort
      );
      await refreshRuntime();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const stop = async (port: number) => {
    if (!sessionId) return;
    try {
      await api.forwardStop(sessionId, port);
      await refreshRuntime();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const confirmDelete = async () => {
    const rule = pendingDelete;
    if (!rule) return;
    setPendingDelete(null);
    try {
      // 先停监听再删规则，避免留下一个「无主」的后台端口
      if (sessionId && isRunning(rule.localPort)) {
        await api.forwardStop(sessionId, rule.localPort);
      }
      await api.deleteForward(rule.id);
      await Promise.all([refreshRules(), refreshRuntime()]);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  /** 没有对应规则、只在本次会话里启动的监听 */
  const rulePorts = new Set(rules.map((r) => r.localPort));
  const extraRuntime = runtime.filter((r) => !rulePorts.has(r.localPort));

  const route = (port: number, host: string, remote: number) => (
    <span className="route">
      <span className="local">127.0.0.1:{port}</span>
      <Icon name="chevron-right" size={13} className="arrow" />
      <span className="remote">
        {host}:{remote}
      </span>
    </span>
  );

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-label="端口转发"
        className="dialog"
        style={{ width: 600 }}
      >
        <header>
          <Icon name="port-forward" size={15} />
          端口转发
        </header>

        <div className="body">
          {!hostId ? (
            <div className="banner info">
              <Icon name="info" />
              <span>请先选择一个主机</span>
            </div>
          ) : (
            <>
              <div className="banner info">
                <Icon name="info" />
                <span>
                  {connected
                    ? "规则按主机保存；勾选「自动」的规则会在每次连接建立后自动启动。"
                    : "当前会话未连接：规则仍可编辑，连上后才能启动监听。"}
                </span>
              </div>

              <div className="row">
                <div className="field col" style={{ flex: 1 }}>
                  <label>本地端口</label>
                  <input
                    value={localPort}
                    onChange={(e) => setLocalPort(e.target.value)}
                    placeholder="8080"
                  />
                </div>
                <div className="field col" style={{ flex: 2 }}>
                  <label>远端地址</label>
                  <input
                    value={remoteHost}
                    onChange={(e) => setRemoteHost(e.target.value)}
                    placeholder="127.0.0.1"
                  />
                </div>
                <div className="field col" style={{ flex: 1 }}>
                  <label>远端端口</label>
                  <input
                    value={remotePort}
                    onChange={(e) => setRemotePort(e.target.value)}
                    placeholder="80"
                  />
                </div>
              </div>

              <div className="fwd-save-row">
                <label className="fwd-auto" title="每次连接建立后自动启动">
                  <input
                    type="checkbox"
                    checked={autoStart}
                    onChange={(e) => setAutoStart(e.target.checked)}
                  />
                  连接后自动启动
                </label>
                <button
                  className="btn primary"
                  onClick={saveRule}
                  disabled={busy}
                >
                  <Icon name="plus" size={14} />
                  {busy ? "保存中…" : connected ? "保存并启动" : "保存规则"}
                </button>
              </div>

              {rules.length > 0 && (
                <div className="forward-list">
                  {rules.map((r) => {
                    const running = isRunning(r.localPort);
                    return (
                      <div key={r.id} className="forward-row">
                        {route(r.localPort, r.remoteHost, r.remotePort)}
                        <span className="fwd-actions">
                          {running && <span className="fwd-badge">监听中</span>}
                          <label className="fwd-auto" title="每次连接时自动启动">
                            <input
                              type="checkbox"
                              checked={r.autoStart}
                              onChange={() => void toggleAuto(r)}
                            />
                            自动
                          </label>
                          <button
                            className="btn sm"
                            disabled={!connected}
                            title={
                              connected
                                ? running
                                  ? "停止监听"
                                  : "启动监听"
                                : "当前会话未连接"
                            }
                            onClick={() =>
                              running ? void stop(r.localPort) : void start(r)
                            }
                          >
                            <Icon
                              name={running ? "close" : "forward"}
                              size={12}
                            />
                            {running ? "停止" : "启动"}
                          </button>
                          <button
                            className="btn sm danger"
                            title="删除规则"
                            onClick={() => setPendingDelete(r)}
                          >
                            <Icon name="trash" size={12} />
                            删除
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {extraRuntime.length > 0 && (
                <div className="forward-list">
                  {extraRuntime.map((f) => (
                    <div key={`rt-${f.localPort}`} className="forward-row">
                      {route(f.localPort, f.remoteHost, f.remotePort)}
                      <span className="fwd-actions">
                        <span className="fwd-badge">监听中</span>
                        <button
                          className="btn sm"
                          onClick={() => void stop(f.localPort)}
                        >
                          <Icon name="close" size={12} />
                          停止
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {rules.length === 0 && extraRuntime.length === 0 && (
                <div
                  className="empty"
                  style={{ height: "auto", padding: "16px 0" }}
                >
                  <span className="title">还没有转发规则</span>
                  <span className="hint">
                    保存后规则会跟着主机走，下次连接可以自动生效
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <footer>
          <button className="btn outline" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="删除转发规则"
          icon="trash"
          confirmText="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        >
          确定删除规则「127.0.0.1:{pendingDelete.localPort} →{" "}
          {pendingDelete.remoteHost}:{pendingDelete.remotePort}」？
          {sessionId && isRunning(pendingDelete.localPort)
            ? " 正在运行的监听也会一并停止。"
            : ""}
        </ConfirmDialog>
      )}
    </div>
  );
}
