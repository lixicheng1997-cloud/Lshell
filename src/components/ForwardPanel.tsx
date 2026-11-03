import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type ForwardRuntime } from "../lib/api";
import Icon from "./Icon";

interface Props {
  sessionId: string | null;
  onClose: () => void;
  onError: (msg: string) => void;
}

/**
 * 端口转发管理面板。
 *
 * 转发随会话生命周期自动启停：关闭标签即停止监听。
 */
export default function ForwardPanel({ sessionId, onClose, onError }: Props) {
  const [forwards, setForwards] = useState<ForwardRuntime[]>([]);
  const [localPort, setLocalPort] = useState("8080");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("80");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setForwards([]);
      return;
    }
    try {
      setForwards(await api.forwardList(sessionId));
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [sessionId, onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = async () => {
    if (!sessionId) return;
    const lp = Number(localPort);
    const rp = Number(remotePort);
    if (!lp || lp < 1 || lp > 65535) return onError("本地端口无效");
    if (!rp || rp < 1 || rp > 65535) return onError("远端端口无效");
    if (!remoteHost.trim()) return onError("远端地址不能为空");

    setBusy(true);
    try {
      await api.forwardStart(sessionId, lp, remoteHost.trim(), rp);
      await refresh();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (port: number) => {
    if (!sessionId) return;
    try {
      await api.forwardStop(sessionId, port);
      await refresh();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" style={{ width: 540 }}>
        <header>
          <Icon name="port-forward" size={15} />
          端口转发
        </header>

        <div className="body">
          {!sessionId ? (
            <div className="banner info">
              <Icon name="info" />
              <span>请先连接一个主机</span>
            </div>
          ) : (
            <>
              <div className="banner info">
                <Icon name="info" />
                <span>转发会复用当前 SSH 连接，关闭标签后自动停止。</span>
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

              <button
                className="btn primary"
                onClick={add}
                disabled={busy}
                style={{ alignSelf: "flex-start" }}
              >
                <Icon name="plus" size={14} />
                {busy ? "启动中…" : "添加转发"}
              </button>

              {forwards.length > 0 && (
                <div className="forward-list">
                  {forwards.map((f) => (
                    <div key={f.localPort} className="forward-row">
                      <span className="route">
                        <span className="local">127.0.0.1:{f.localPort}</span>
                        <Icon name="chevron-right" size={13} className="arrow" />
                        <span className="remote">
                          {f.remoteHost}:{f.remotePort}
                        </span>
                      </span>
                      <button
                        className="btn sm danger"
                        onClick={() => remove(f.localPort)}
                      >
                        <Icon name="trash" size={12} />
                        停止
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {forwards.length === 0 && (
                <div className="empty" style={{ height: "auto", padding: "16px 0" }}>
                  <span className="title">还没有转发规则</span>
                  <span className="hint">
                    添加后本地端口会监听并转发到远端地址
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
    </div>
  );
}
