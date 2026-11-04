import { createPortal } from "react-dom";
import { useShortcuts } from "../lib/shortcuts";
import type { AppInfo } from "../lib/types";
import Brand from "./Brand";
import Icon from "./Icon";

interface Props {
  info: AppInfo;
  onClose: () => void;
}

/**
 * 关于对话框。
 *
 * 版本号与作者来自 Rust 侧的 app_info 命令，
 * 而 app_info 读的是 Cargo.toml 的编译期环境变量 ——
 * 与安装包里的 Publisher、exe 版本资源同源，不会各写一份。
 */
export default function AboutDialog({ info, onClose }: Props) {
  // 打开时按 Escape 关闭
  useShortcuts([
    {
      combo: "escape",
      description: "关闭",
      handler: onClose,
    },
  ]);

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" style={{ width: 400 }}>
        <header>
          <Icon name="info" size={15} />
          关于
        </header>

        <div className="body">
          <div className="about-head">
            <Brand height={20} className="logo" />
          </div>

          <p className="about-desc">{info.description}</p>

          <div className="about-rows">
            <div className="about-row">
              <span className="k">版本</span>
              <span className="v mono">{info.version}</span>
            </div>
            <div className="about-row">
              <span className="k">作者</span>
              <span className="v">{info.author}</span>
            </div>
          </div>
        </div>

        <footer>
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            关闭
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
