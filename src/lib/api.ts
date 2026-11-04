/** Rust 命令的 TypeScript 封装 */
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import type {
  AppInfo,
  Forward,
  Group,
  Host,
  HostInput,
  KnownHost,
  Tag,
} from "./types";

/** 终端通道帧类型（对应 Rust 侧 session::FRAME_*） */
export const FRAME_DATA = 0x00;
export const FRAME_CLOSED = 0x01;
/** 会话状态变化帧，载荷是 SessionNotice 的 JSON */
export const FRAME_STATUS = 0x02;

/**
 * 终端通道收到的是原始字节（ArrayBuffer）。
 *
 * 通道走 Tauri 的 Raw 二进制通道，不做 JSON 序列化 ——
 * 终端输出是高频字节流，JSON 编码会明显拖慢渲染。
 * 1 字节帧头区分帧的种类。
 */
export type TerminalFrame = ArrayBuffer;

/** 会话状态变化 */
export type NoticeState =
  | "reconnecting"
  | "reconnected"
  | "disconnected"
  | "closed";

/** Rust 侧下发的会话状态通知 */
export interface SessionNotice {
  state: NoticeState;
  /** 当前是第几次重试（从 1 开始） */
  attempt?: number;
  /** 下次重试前的等待毫秒数 */
  delayMs?: number;
  /** 面向用户的说明 */
  message?: string;
}

/** 解析状态帧载荷；不是合法 JSON 时返回 null */
export function parseNotice(payload: Uint8Array): SessionNotice | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(payload));
    if (obj && typeof obj.state === "string") return obj as SessionNotice;
    return null;
  } catch {
    return null;
  }
}

/** 连接结果，与 Rust 侧 models::ConnectOutcome 对应 */
export type ConnectOutcome =
  | { status: "connected" }
  | { status: "needsHostKeyTrust"; fingerprint: string; algo: string };

export const api = {
  // 应用
  /** 应用元信息：名称、版本、作者、简介 */
  appInfo: () => invoke<AppInfo>("app_info"),

  // 主机
  listHosts: (search?: string) => invoke<Host[]>("list_hosts", { search: search ?? null }),
  getHost: (id: number) => invoke<Host | null>("get_host", { id }),
  saveHost: (input: HostInput, id?: number) =>
    invoke<number>("save_host", { input, id: id ?? null }),
  deleteHost: (id: number) => invoke<void>("delete_host", { id }),

  // 标签
  listTags: () => invoke<Tag[]>("list_tags"),
  upsertTag: (name: string, color: string) =>
    invoke<Tag>("upsert_tag", { name, color }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),

  // 分组
  listGroups: () => invoke<Group[]>("list_groups"),
  createGroup: (name: string, parentId?: number | null) =>
    invoke<number>("create_group", { name, parentId: parentId ?? null }),
  renameGroup: (id: number, name: string) =>
    invoke<void>("rename_group", { id, name }),
  deleteGroup: (id: number) => invoke<void>("delete_group", { id }),

  // 转发
  listForwards: (hostId: number) =>
    invoke<Forward[]>("list_forwards", { hostId }),
  saveForward: (hostId: number, forward: Forward) =>
    invoke<number>("save_forward", { hostId, forward }),
  deleteForward: (id: number) => invoke<void>("delete_forward", { id }),

  // 已知主机
  listKnownHosts: () => invoke<KnownHost[]>("list_known_hosts"),
  deleteKnownHost: (id: number) => invoke<void>("delete_known_host", { id }),
  trustHostKey: (host: string, port: number, algo: string, fingerprint: string) =>
    invoke<void>("trust_host_key", { host, port, algo, fingerprint }),

  // 设置
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),

  // 命令历史
  /** 记录一条已执行的命令，返回记录 id */
  recordCommand: (hostId: number, command: string, cwd?: string) =>
    invoke<number>("record_command", { hostId, command, cwd: cwd ?? "" }),
  /** 列出命令历史；hostId 传 null 表示跨全部主机 */
  listCommandHistory: (
    hostId: number | null,
    query?: string,
    limit?: number
  ) =>
    invoke<CommandRecord[]>("list_command_history", {
      hostId,
      query: query ?? null,
      limit: limit ?? null,
    }),
  /** 清空命令历史；hostId 传 null 表示清空全部 */
  clearCommandHistory: (hostId: number | null) =>
    invoke<number>("clear_command_history", { hostId }),

  // SSH 会话
  connectHost: (
    hostId: number,
    sessionId: string,
    onFrame: (frame: TerminalFrame) => void
  ) => {
    const channel = new Channel<TerminalFrame>();
    channel.onmessage = onFrame;
    return invoke<ConnectOutcome>("connect_host", {
      hostId,
      sessionId,
      channel,
    });
  },
  disconnectHost: (sessionId: string) =>
    invoke<void>("disconnect_host", { sessionId }),
  terminalWrite: (sessionId: string, data: number[]) =>
    invoke<void>("terminal_write", { sessionId, data }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  sessionState: (sessionId: string) =>
    invoke<string | null>("session_state", { sessionId }),

  // 目录跟踪：让远端 shell 在每次显示提示符前上报当前目录（OSC 7）
  enableCwdTracking: (sessionId: string) =>
    invoke<void>("session_enable_cwd_tracking", { sessionId }),

  // SFTP
  sftpList: (sessionId: string, path: string) =>
    invoke<SftpListing>("sftp_list", { sessionId, path }),
  /** 启动下载，返回传输任务 id；进度用 listTransfers 查询 */
  sftpDownload: (
    sessionId: string,
    remotePath: string,
    localPath: string
  ) => invoke<number>("sftp_download", { sessionId, remotePath, localPath }),
  /** 启动上传，返回传输任务 id；进度用 listTransfers 查询 */
  sftpUpload: (
    sessionId: string,
    localPath: string,
    remotePath: string
  ) => invoke<number>("sftp_upload", { sessionId, localPath, remotePath }),
  sftpMkdir: (sessionId: string, path: string) =>
    invoke<void>("sftp_mkdir", { sessionId, path }),
  sftpRemove: (sessionId: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { sessionId, path, isDir }),
  sftpRename: (sessionId: string, fromPath: string, toPath: string) =>
    invoke<void>("sftp_rename", { sessionId, fromPath, toPath }),

  // 文件传输
  /** 列出全部传输任务的状态快照 */
  listTransfers: () => invoke<TransferStatus[]>("list_transfers"),
  /** 请求取消某个传输 */
  cancelTransfer: (id: number) => invoke<boolean>("cancel_transfer", { id }),

  // 端口转发
  forwardStart: (
    sessionId: string,
    localPort: number,
    remoteHost: string,
    remotePort: number
  ) =>
    invoke<void>("forward_start", {
      sessionId,
      localPort,
      remoteHost,
      remotePort,
    }),
  forwardStop: (sessionId: string, localPort: number) =>
    invoke<void>("forward_stop", { sessionId, localPort }),
  forwardList: (sessionId: string) =>
    invoke<ForwardRuntime[]>("forward_list", { sessionId }),
};

/** 远端目录项 */
export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
}

/** 一条命令历史记录 */
export interface CommandRecord {
  id: number;
  hostId: number;
  command: string;
  /** 执行时的远端目录 */
  cwd: string;
  /** Unix 秒级时间戳 */
  createdAt: number;
}

/** 目录列举结果 */
export interface SftpListing {
  /** 解析后的绝对路径 */
  path: string;
  entries: RemoteEntry[];
}

/** 运行中的端口转发 */
export interface ForwardRuntime {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

/** 传输方向 */
export type TransferDirection = "upload" | "download";

/** 传输状态 */
export type TransferState = "running" | "completed" | "failed" | "cancelled";

/** 文件传输任务的状态快照 */
export interface TransferStatus {
  id: number;
  direction: TransferDirection;
  /** 文件名 */
  name: string;
  localPath: string;
  remotePath: string;
  /** 总字节数；远端不返回大小时为 0 */
  total: number;
  /** 已传字节数 */
  transferred: number;
  state: TransferState;
  /** 失败原因 */
  error?: string | null;
  /** 是否可以取消 */
  cancellable: boolean;
}

/** 提取可读的错误信息 */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
