/**
 * 终端当前目录跟踪。
 *
 * 远端 shell 在每次显示提示符前上报当前目录，事实标准是 OSC 7：
 *
 *     ESC ] 7 ; file://hostname/path ESC \
 *
 * iTerm2 的私有协议 OSC 1337 里有等价的 `CurrentDir=` 字段，一并支持。
 *
 * 注意：SSH 传输的是字节流，一条控制序列完全可能被拆在两个数据块里，
 * 所以必须自己维护缓冲区逐块喂入，不能假设一次 read 拿到完整序列。
 */

/** 序列终止符：BEL 或 ST（ESC \） */
interface Terminator {
  /** 负载结束位置（不含终止符） */
  end: number;
  /** 终止符长度 */
  len: number;
}

/** 从 `start` 开始找 OSC 的终止符，找不到返回 null */
function findTerminator(s: string, start: number): Terminator | null {
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x07) return { end: i, len: 1 }; // BEL
    if (c === 0x1b && s.charCodeAt(i + 1) === 0x5c) return { end: i, len: 2 }; // ST
  }
  return null;
}

/** 百分号解码，解不出来就原样返回 */
function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** 从 `file://host/path` 里取出路径 */
function pathFromUri(uri: string): string | null {
  const raw = uri.trim();
  if (!raw) return null;

  const m = /^file:\/\/[^/]*(\/.*)?$/.exec(raw);
  if (m) {
    const p = m[1] ?? "/";
    return decodePath(p || "/");
  }
  // 有些 shell 只给绝对路径
  if (raw.startsWith("/")) return decodePath(raw);
  return null;
}

/**
 * OSC 扫描器。
 *
 * 用法：把终端原始字节喂进 `push`，每次解析出新的当前目录就回调 `onPath`。
 */
export class CwdScanner {
  private buf = "";
  private readonly decoder = new TextDecoder("utf-8");

  constructor(private readonly onPath: (path: string) => void) {}

  /** 喂入一段终端原始字节 */
  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const start = this.buf.indexOf("\u001b]");
      if (start < 0) {
        // 没有 OSC 起始符，只可能是被截断的 ESC
        this.buf = this.buf.endsWith("\u001b") ? "\u001b" : "";
        return;
      }

      const term = findTerminator(this.buf, start + 2);
      if (!term) {
        // 序列还没收全，等下一块数据
        if (this.buf.length - start > 4096) {
          // 明显不是合法 OSC，丢弃后继续找
          this.buf = this.buf.slice(start + 2);
          continue;
        }
        this.buf = this.buf.slice(start);
        return;
      }

      this.handle(this.buf.slice(start + 2, term.end));
      this.buf = this.buf.slice(term.end + term.len);
    }
  }

  /** 处理一条 OSC 的负载（不含 `ESC ]` 与终止符） */
  private handle(body: string): void {
    const sep = body.indexOf(";");
    if (sep < 0) return;
    const code = body.slice(0, sep);
    const payload = body.slice(sep + 1);

    if (code === "7") {
      this.emit(payload);
      return;
    }

    if (code === "1337") {
      for (const part of payload.split(";")) {
        if (part.startsWith("CurrentDir=")) {
          this.emit(part.slice("CurrentDir=".length));
          return;
        }
      }
    }
  }

  private emit(uri: string) {
    const path = pathFromUri(uri);
    if (path && path !== this.last) {
      this.last = path;
      this.onPath(path);
    }
  }

  /** 上一次上报的路径，避免重复回调 */
  private last: string | null = null;
}
