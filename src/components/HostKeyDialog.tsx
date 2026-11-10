import { useState } from "react";
import { useDialogFocus } from "../lib/dialog";
import Icon from "./Icon";

interface Props {
  fingerprint: string;
  algo: string;
  host: string;
  port: number;
  /** 有值表示指纹与既有记录不符，需要用户确认更新 */
  storedFingerprint?: string;
  onTrust: () => void;
  onCancel: () => void;
}

/**
 * 主机指纹确认框。
 *
 * - 首次连接：展示指纹，确认后写入 known_hosts。
 * - 指纹变更：同时展示旧指纹与新指纹，用户点击「确认更新」后才替换记录。
 * 两种情况都必须由用户显式确认，不存在静默信任。
 */
export default function HostKeyDialog({
  fingerprint,
  algo,
  host,
  port,
  storedFingerprint,
  onTrust,
  onCancel,
}: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();
  const [copied, setCopied] = useState(false);
  const changed = Boolean(storedFingerprint);

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
      <div
        ref={ref}
        {...dialogProps}
        aria-label={changed ? "主机密钥已变更" : "确认主机身份"}
        className="dialog"
        style={{ width: 500 }}
      >
        <header>
          <Icon name={changed ? "alert-triangle" : "shield"} size={15} />
          {changed ? "主机密钥已变更" : "确认主机身份"}
        </header>

        <div className="body">
          {changed ? (
            <div className="banner warn">
              <Icon name="alert-triangle" />
              <span>
                <strong>{host}:{port}</strong>{" "}
                提供的密钥与上次记录不一致。可能是服务器重装或轮换密钥，
                也可能是中间人攻击 —— 请通过可信渠道核对后再更新。
              </span>
            </div>
          ) : (
            <div className="banner info">
              <Icon name="info" />
              <span>
                这是首次连接 <strong>{host}:{port}</strong>。
                请确认下面的主机密钥指纹与服务器提供的一致。
              </span>
            </div>
          )}

          <div className="field">
            <label>算法</label>
            <div className="mono">{algo}</div>
          </div>

          {changed && storedFingerprint && (
            <div className="field">
              <label>记录指纹（原）</label>
              <div
                className="mono"
                style={{
                  padding: "7px 9px",
                  background: "var(--bg-app)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-sm)",
                  wordBreak: "break-all",
                  color: "var(--fg-muted)",
                }}
              >
                {storedFingerprint}
              </div>
            </div>
          )}

          <div className="field">
            <label>{changed ? "当前指纹（新）" : "指纹"}</label>
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

          {!changed && (
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
          )}
        </div>

        <footer>
          <button className="btn outline" onClick={onCancel}>
            取消
          </button>
          <button
            className={`btn ${changed ? "danger" : "primary"}`}
            onClick={onTrust}
          >
            <Icon name={changed ? "alert-triangle" : "shield-check"} size={14} />
            {changed ? "确认更新并连接" : "信任并连接"}
          </button>
        </footer>
      </div>
    </div>
  );
}
