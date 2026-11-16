/** 与 Rust 侧共享的数据类型（对应 src-tauri/src/models.rs） */

/** 应用元信息（对应 Rust 侧 models::AppInfo） */
export interface AppInfo {
  name: string;
  version: string;
  author: string;
  description: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export interface Group {
  id: number;
  name: string;
  parentId: number | null;
  sortOrder: number;
}

export interface Host {
  id: number;
  alias: string;
  address: string;
  port: number;
  username: string;
  authType: "password" | "key" | "agent";
  groupId: number | null;
  note: string;
  keyPath: string | null;
  sortOrder: number;
  createdAt: number;
  lastUsedAt: number | null;
  tags: Tag[];
  proxyType: "none" | "http" | "socks5";
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  jumpHostId: number | null;
  term: string;
  encoding: string;
  startupCommand: string;
}

export interface HostInput {
  alias: string;
  address: string;
  port: number;
  username: string;
  authType: "password" | "key" | "agent";
  groupId: number | null;
  note: string;
  keyPath: string | null;
  password?: string | null;
  keyPassphrase?: string | null;
  tagIds: number[];
  proxyType?: "none" | "http" | "socks5" | null;
  proxyHost?: string | null;
  proxyPort?: number | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
  jumpHostId?: number | null;
  term?: string | null;
  encoding?: string | null;
  startupCommand?: string | null;
}

export interface Snippet {
  id: number;
  name: string;
  command: string;
  sortOrder: number;
  createdAt: number;
}

export interface ImportCandidate {
  alias: string;
  address: string;
  port: number;
  username: string;
  keyPath: string | null;
  jump: string | null;
  note: string;
}

export interface ImportWarning {
  line: number;
  message: string;
}

export interface ImportPreview {
  path: string;
  /** sshConfig / json */
  format: string;
  candidates: ImportCandidate[];
  warnings: ImportWarning[];
  duplicates: number;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
}

export interface Forward {
  id: number;
  hostId: number;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface KnownHost {
  id: number;
  host: string;
  port: number;
  algo: string;
  fingerprint: string;
  addedAt: number;
}
