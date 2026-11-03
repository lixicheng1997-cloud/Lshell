import { useState } from "react";
import Icon from "./Icon";

interface Props {
  fingerprint: string;
  algo: string;
  host: string;
  port: number;
  onTrust: () => void;
  onCancel: () => void;
}

/**
 * 首次连接某台主机时的指纹确认框。
 *
 * 只有用户显式确认后，主机密钥才会写入 known_hosts。
 */
export default function HostKeyDialog({
  fingerprint,
  algo,
  host,
  port,
  onTrust,
  onCancel,
}: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时忽略
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="dialog" style={{ width: 500 }}>
        <header>
          <Icon name="shield" size={15} />
          确认主机身份
        </header>

        <div className="body">
          <div className="banner info">
            <Icon name="info" />
            <span>
              这是首次连接 <strong>{host}:{port}</strong>。
              请确认下面的主机密钥指纹与服务器提供的一致。
            </span>
          </div>

          <div className="field">
            <label>算法</label>
            <div className="mono">{algo}</div>
          </div>

          <div className="field">
            <label>指纹</label>
            <div className="row">
              <div
                className="mono"
                style={{
                  flex: 1,
                  padding: "7px 9px",
                  background: "var(--bg-app)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-sm)",
                  wordBreak: "break-all",
                }}
              >
                {fingerprint}
              </div>
              <button className="btn outline" onClick={copy}>
                <Icon name={copied ? "check" : "copy"} size={13} />
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>

          <div className="banner warn">
            <Icon name="alert-triangle" />
            <span>
              可在服务器上执行{" "}
              <span className="mono">
                ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
              </span>{" "}
              核对指纹。确认后该指纹会被记住，以后连接若指纹变化会立即告警。
            </span>
          </div>
        </div>

        <footer>
          <button className="btn outline" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" onClick={onTrust}>
            <Icon name="shield-check" size={14} />
            信任并连接
          </button>
        </footer>
      </div>
    </div>
  );
}
