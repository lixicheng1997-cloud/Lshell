/**
 * 剪贴板写入。
 *
 * 优先用异步 Clipboard API；在 WebView 里偶发不可用（权限或非安全上下文）时，
 * 回退到隐藏 textarea + execCommand("copy") 的老办法。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 继续走回退方案
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 读取剪贴板文本。
 *
 * 与写入一样：优先用异步 Clipboard API，失败时回退到
 * 隐藏 textarea + execCommand("paste")。
 *
 * WebView 里读取剪贴板常被权限拦住，因此调用方要准备好降级：
 * 拿不到内容时提示用户手动粘贴，而不是静默失败。
 */
export async function readText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    // 继续走回退方案
  }

  try {
    const area = document.createElement("textarea");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    const ok = document.execCommand("paste");
    const text = ok ? area.value : null;
    area.remove();
    return text;
  } catch {
    return null;
  }
}

/**
 * 读取剪贴板并交给回调处理。
 *
 * 读不到内容时回调收到 null，调用方决定如何提示。
 */
export async function pasteText(handler: (text: string) => void): Promise<boolean> {
  const text = await readText();
  if (text == null || text === "") return false;
  handler(text);
  return true;
}
