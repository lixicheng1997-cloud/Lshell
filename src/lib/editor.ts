/** 远程文本编辑器的前端辅助：base64 编解码、EOL/BOM 还原、语言包懒加载。 */

import type { Extension } from "@codemirror/state";

export function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToText(bytes: Uint8Array): string {
  // TextDecoder 默认 stripBOM，正好与保存时手工写回 BOM 对称
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 把编辑器里的文本还原成远端原始字节。
 * CodeMirror 内部统一用 \n，保存时按打开时记录的 EOL 与 BOM 还原，
 * 避免因为换行符规范化产生整文件 diff。
 */
export function encodeForSave(
  text: string,
  eol: "lf" | "crlf" | "none",
  bom: boolean
): Uint8Array {
  const normalized = text.replace(/\r\n?/g, "\n");
  const withEol = eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const bytes = new TextEncoder().encode(withEol);
  if (!bom) return bytes;
  const out = new Uint8Array(bytes.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(bytes, 3);
  return out;
}

/** 引入 stream 模式（服务器配置文件多数没有官方 lang-* 包） */
async function streamMode(
  loader: () => Promise<{ [key: string]: unknown }>,
  name: string
): Promise<Extension | null> {
  const [{ StreamLanguage }, mod] = await Promise.all([
    import("@codemirror/language"),
    loader(),
  ]);
  const parser = mod[name];
  return parser ? StreamLanguage.define(parser as never) : null;
}

/**
 * 按 Rust 侧给出的语言标识动态加载语法支持。
 * 每个 import 都是独立 chunk，主 bundle 只包含 core 与基础扩展。
 */
export async function loadLanguage(language: string): Promise<Extension | null> {
  switch (language) {
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "yaml":
      return streamMode(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml");
    case "toml":
      return streamMode(() => import("@codemirror/legacy-modes/mode/toml"), "toml");
    case "properties":
      return streamMode(
        () => import("@codemirror/legacy-modes/mode/properties"),
        "properties"
      );
    case "shell":
      return streamMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell");
    case "nginx":
      return streamMode(() => import("@codemirror/legacy-modes/mode/nginx"), "nginx");
    case "dockerfile":
      return streamMode(
        () => import("@codemirror/legacy-modes/mode/dockerfile"),
        "dockerfile"
      );
    case "go":
      return streamMode(() => import("@codemirror/legacy-modes/mode/go"), "go");
    case "ruby":
      return streamMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby");
    default:
      return null;
  }
}
