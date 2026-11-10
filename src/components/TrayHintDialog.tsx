import { createPortal } from "react-dom";
import { useDialogFocus } from "../lib/dialog";
import Icon from "./Icon";

interface Props {
  /** 点「知道了」后隐藏窗口 */
  onConfirm: () => void;
}

/**
 * 首次关闭到托盘时的一次性说明。
 *
 * 只出现一次：用户确认后再关闭窗口就直接隐藏，不再打扰。
 */
export default function TrayHintDialog({ onConfirm }: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();

  return createPortal(
    <div className="overlay">
      <div
        ref={ref}
        {...dialogProps}
        aria-label="已最小化到托盘"
        className="dialog"
        style={{ width: 420 }}
      >
        <header>
          <Icon name="info" size={15} />
          已最小化到托盘
        </header>

        <div className="body">
          <div className="banner info">
            <Icon name="info" />
            <span>
              Lshell 会继续在后台运行，SSH 会话保持连接。
              <br />
              单击托盘图标可恢复窗口；右键托盘选择「退出 Lshell」，或按{" "}
              <strong>Ctrl+Q</strong> 才能真正退出。
            </span>
          </div>
        </div>

        <footer>
          <button type="button" className="btn primary" onClick={onConfirm} autoFocus>
            知道了
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
