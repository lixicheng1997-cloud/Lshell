/**
 * 终端命令捕获。
 *
 * 终端拿到的是字节流，不是"命令"。要还原用户实际执行了什么，
 * 需要在本地维护一个「当前输入行」的镜像。
 *
 * 难点在于：远端 shell 有自己的行编辑能力（readline），
 * 它处理方向键、Tab 补全、历史召回。本地镜像跟不上，
 * 所以这里采用**保守策略**：
 *
 * - 只在能确定内容时才记录 —— 退格、Ctrl+U、Ctrl+W 这些
 *   可精确还原的编辑操作精确处理；
 * - 遇到无法解析的转义序列（方向键、Tab 补全等），
 *   把当前行标记为「不可信」，这一行就不记录了。
 *
 * 宁可少记，不可记错 —— 错误的历史比没有历史更糟。
 */

/** 控制字符 */
const CTRL_C = 0x03;
const CTRL_U = 0x15;
const CTRL_W = 0x17;
const CTRL_D = 0x04;
const BACKSPACE = 0x7f;
const CR = 0x0d;
const LF = 0x0a;
const ESC = 0x1b;
const TAB = 0x09;

/**
 * 会紧跟一行密码输入的命令。
 *
 * 这些命令执行后，远端会提示输入密码，而密码输入**不回显** ——
 * 终端上看不到任何字符，但我们仍然能捕获到用户实际敲进去的内容。
 * 若原样入库，密码就会明文躺在数据库里。
 *
 * 因此在捕获到这些命令之后，紧接着的那一行一律不记录。
 */
const PASSWORD_PROMPTING_COMMANDS = ["sudo", "su", "passwd", "login", "ssh", "mysql", "psql", "redis-cli"];

/**
 * 命令捕获器。
 *
 * 用法：把终端的 onData 文本喂进 `push()`，
 * 它在用户按下回车时返回该次执行的命令（不该记录时返回 null）。
 */
export class CommandCapture {
  /** 当前输入行的镜像 */
  private line = "";
  /** 当前行是否仍然可信 */
  private trusted = true;
  /** 上一条已提交的命令，用于抑制连续重复 */
  private lastCommitted: string | null = null;
  /** 下一行是否为密码输入 */
  private awaitingPassword = false;

  /**
   * 喂入一段终端输入。
   *
   * @param data xterm 的 onData 载荷（已解码为字符串）
   * @returns 这次提交的命令；不该记录时返回 null
   */
  push(data: string): string | null {
    let committed: string | null = null;

    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);

      // ESC 开头的是转义序列，交给远端处理，本地无法还原内容
      if (code === ESC) {
        i = skipEscapeSequence(data, i);
        this.trusted = false;
        continue;
      }

      switch (code) {
        case CR:
        case LF: {
          // 回车：提交当前行
          const text = this.line.trim();
          if (this.trusted && text) {
            if (this.awaitingPassword) {
              // 这一行是密码，绝不入库
              this.awaitingPassword = false;
              this.lastCommitted = null;
            } else {
              // 与上一条完全相同则不重复返回（数据库侧也会去重）
              committed = text === this.lastCommitted ? null : text;
              if (committed) {
                this.lastCommitted = committed;
                this.awaitingPassword = promptsForPassword(committed);
              }
            }
          } else if (this.trusted) {
            // 空行：取消「等待密码」状态
            // （用户按了回车却没有输入内容）
            this.awaitingPassword = false;
          }
          this.reset();
          continue;
        }

        case BACKSPACE:
          // 退格删一个字符
          if (this.line.length > 0) {
            this.line = this.line.slice(0, -1);
          }
          continue;

        case CTRL_U:
          // Ctrl+U 清空整行
          this.line = "";
          continue;

        case CTRL_W:
          // Ctrl+W 删上一个词
          this.line = this.line.replace(/\S+\s*$/, "");
          continue;

        case CTRL_C:
          // Ctrl+C 放弃当前行，不提交
          this.reset();
          this.awaitingPassword = false;
          continue;

        case CTRL_D:
          // Ctrl+D 结束输入
          this.reset();
          continue;

        case TAB:
          // Tab 补全由远端完成，本地无法知道补成了什么
          this.trusted = false;
          continue;

        default:
          // 其余控制字符（Ctrl+A/B/E/K 等）会移动或删除光标位置，
          // 本地无法精确还原，标记为不可信
          if (code < 0x20) {
            this.trusted = false;
            continue;
          }
          // 普通可打印字符
          this.line += data[i];
          continue;
      }
    }

    return committed;
  }

  /** 丢弃当前行 */
  private reset() {
    this.line = "";
    this.trusted = true;
  }

  /** 当前行的镜像（调试用） */
  get currentLine(): string {
    return this.line;
  }

  /** 当前行是否可信 */
  get isTrusted(): boolean {
    return this.trusted;
  }
}

/**
 * 判断某条命令之后是否会紧跟一行密码输入。
 */
export function promptsForPassword(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // 取第一个词，但跳过前置的 env 之类包装器
  const words = trimmed.split(/\s+/);
  let head = words[0].toLowerCase();

  // sudo / su 一定会自己要密码 ——
  // 哪怕写成 `sudo -u root systemctl status nginx`，
  // 提示密码的仍是 sudo 本身，而不是内层命令。
  if (head === "sudo" || head === "su") return true;

  // env 只是包装器，真正提示密码的是它启动的那个程序
  if (head === "env" && words.length > 1) {
    head = words[words.length - 1].toLowerCase();
  }

  return PASSWORD_PROMPTING_COMMANDS.includes(head);
}

/**
 * 跳过 ESC 开始的转义序列，返回序列结束后的下标。
 *
 * CSI 序列形如 `ESC [ 参数 终止符`，其中终止符在 0x40–0x7E 之间；
 * OSC 序列形如 `ESC ] ... BEL` 或 `ESC ] ... ESC \`。
 * 其它单字符转义（ESC A、ESC B 等）只占两个字节。
 */
function skipEscapeSequence(data: string, start: number): number {
  const next = data[start + 1];
  if (next === undefined) return start;

  if (next === "[") {
    // CSI：一直找到终止符
    for (let i = start + 2; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i;
    }
    return data.length - 1;
  }

  if (next === "]") {
    // OSC：BEL(0x07) 或 ST(ESC \) 结束
    for (let i = start + 2; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code === 0x07) return i;
      if (code === ESC && data.charCodeAt(i + 1) === 0x5c) return i + 1;
    }
    return data.length - 1;
  }

  // 其它：两字节序列
  return start + 1;
}
