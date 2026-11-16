import { useDialogFocus } from "../lib/dialog";
import { useShortcuts, type Shortcut } from "../lib/shortcuts";
import Icon from "./Icon";

interface Props {
  onClose: () => void;
  /** 由 App 传入实际生效的快捷键列表 */
  shortcuts: Shortcut[];
}

const LABELS: Record<string, string> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  // 滚轮不是键盘键，单独给个中文名，避免渲染成 "WHEEL"
  wheel: "滚轮",
};

/** 把 "mod+shift+f" 拆成 ["Ctrl", "Shift", "F"]，逐键渲染 */
function pretty(combo: string): string[] {
  return combo
    .split("+")
    .map((k) => LABELS[k] ?? k.toUpperCase());
}

export default function ShortcutHelp({ onClose, shortcuts }: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();

  // 帮助面板打开时按 Escape 关闭
  useShortcuts([
    {
      combo: "escape",
      description: "关闭",
      handler: onClose,
    },
  ]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-label="快捷键"
        className="dialog"
        style={{ width: 440 }}
      >
        <header>
          <Icon name="keyboard" size={15} />
          快捷键
        </header>

        <div className="body">
          <div className="banner info">
            <Icon name="info" />
            <span>
              终端内 Ctrl+C 在有选区时复制、无选区时中断进程；Ctrl+V 直接粘贴。
            </span>
          </div>

          {shortcuts.map((s) => (
            <div key={s.combo} className="shortcut-row">
              <span className="desc">{s.description}</span>
              <span className="combo">
                {pretty(s.combo).map((k, i) => (
                  <kbd key={i} className="kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
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
