/** Rust 命令的 TypeScript 封装 */
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import type {
  AppInfo,
  Forward,
  Group,
  Host,
  HostInput,
  ImportPreview,
  ImportSummary,
  KnownHost,
  Snippet,
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
  | { status: "needsHostKeyTrust"; fingerprint: string; algo: string }
  | {
      status: "hostKeyChanged";
      fingerprint: string;
      algo: string;
      storedFingerprint: string;
    };

export const api = {
  // 应用
  /** 应用元信息：名称、版本、作者、简介 */
  appInfo: () => invoke<AppInfo>("app_info"),
  /** 显式退出（绕过「关闭到托盘」） */
  exitApp: () => invoke<void>("exit_app"),

  // 自动更新
  /** 查询更新；没有新版本时返回 null */
  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),
  /** 下载并校验更新包，暂存待安装 */
  downloadUpdate: () => invoke<void>("download_update"),
  /** 安装已下载的更新；Windows 上会退出当前进程 */
  applyUpdate: () => invoke<void>("apply_update"),

  // 主机
  listHosts: (search?: string) => invoke<Host[]>("list_hosts", { search: search ?? null }),
  getHost: (id: number) => invoke<Host | null>("get_host", { id }),
  saveHost: (input: HostInput, id?: number) =>
    invoke<number>("save_host", { input, id: id ?? null }),
  deleteHost: (id: number) => invoke<void>("delete_host", { id }),
  duplicateHost: (id: number) => invoke<Host>("duplicate_host", { id }),
  /** 最近连接（按最后使用时间倒序） */
  listRecentHosts: (limit = 6) =>
    invoke<Host[]>("list_recent_hosts", { limit }),
  /** 导入预检：只解析不写库 */
  previewHostImport: (path?: string | null) =>
    invoke<ImportPreview>("preview_host_import", { path: path ?? null }),
  /** 执行导入；同地址+端口+用户名的主机会被跳过 */
  importHosts: (path?: string | null) =>
    invoke<ImportSummary>("import_hosts", { path: path ?? null }),
  /** 导出主机库（json / sshConfig），不含凭据 */
  exportHosts: (path: string, format: "json" | "sshConfig") =>
    invoke<number>("export_hosts", { path, format }),

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
  /** 拖拽：按新顺序写回组内主机（含移入该组） */
  reorderHosts: (groupId: number | null, ids: number[]) =>
    invoke<void>("reorder_hosts", { groupId, ids }),
  /** 拖拽：按新顺序写回分组 */
  reorderGroups: (ids: number[]) => invoke<void>("reorder_groups", { ids }),

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
  /** 一次性读取全部设置（启动时用，避免逐键 IPC） */
  getAllSettings: () => invoke<Record<string, string>>("get_all_settings"),
  /** 删除某项设置，回到注册表默认值 */
  deleteSetting: (key: string) => invoke<void>("delete_setting", { key }),

  // 终端背景图
  /** 把本地图片复制到应用数据目录，返回持久化路径 */
  saveTerminalBackground: (sourcePath: string) =>
    invoke<string>("save_terminal_background", { sourcePath }),
  /** 删除应用数据目录下的背景图 */
  deleteTerminalBackground: (path: string) =>
    invoke<void>("delete_terminal_background", { path }),
  /** 读取背景图并转成 data URL（CSP 只允许 data:） */
  terminalBackgroundDataUrl: (path: string) =>
    invoke<string>("terminal_background_data_url", { path }),
  /** 背景图文件是否仍然存在 */
  terminalBackgroundExists: (path: string) =>
    invoke<boolean>("terminal_background_exists", { path }),

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

  // 常用命令片段
  listSnippets: () => invoke<Snippet[]>("list_snippets"),
  /** 新建或更新片段；id 传 null 表示新建 */
  saveSnippet: (name: string, command: string, id?: number | null) =>
    invoke<number>("save_snippet", { id: id ?? null, name, command }),
  deleteSnippet: (id: number) => invoke<void>("delete_snippet", { id }),

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
  /** 会话累计流量（字节）；网速由前端按差值计算 */
  sessionNetStats: (sessionId: string) =>
    invoke<NetStats>("session_net_stats", { sessionId }),
  /** 目标主机硬件指标（远端不支持时抛错） */
  sessionHostMetrics: (sessionId: string) =>
    invoke<HostMetrics>("session_host_metrics", { sessionId }),
  /** 远端当前登录用户（exec whoami，取不到时抛错） */
  sessionCurrentUser: (sessionId: string) =>
    invoke<string>("session_current_user", { sessionId }),
  /** 远端挂载卷占用（df -Pk，取不到时抛错） */
  sessionDiskUsage: (sessionId: string) =>
    invoke<MountUsage[]>("session_disk_usage", { sessionId }),

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

/** 可用的应用更新 */
export interface UpdateInfo {
  /** 新版本号 */
  version: string;
  /** 当前版本号 */
  currentVersion: string;
  /** 更新说明，可能为空 */
  notes: string;
  /** 发布日期，可能为空 */
  date: string | null;
}

/** 更新包下载进度 */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  /** 0-100；服务端未返回总大小时为 null */
  percent: number | null;
}

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

/** 会话累计流量（字节） */
export interface NetStats {
  rxBytes: number;
  txBytes: number;
}

/** 目标主机硬件指标 */
export interface HostMetrics {
  hostname: string;
  os: string;
  cpuModel: string;
  cores: number;
  cpuPercent: number;
  /** 1/5/15 分钟负载，空格分隔；取不到时为空串 */
  load: string;
  memTotalKb: number;
  memUsedKb: number;
  diskTotalKb: number;
  diskUsedKb: number;
  uptimeSecs: number;
}

/** 单个挂载卷占用 */
export interface MountUsage {
  mount: string;
  /** 容量单位：1K 块 */
  totalKb: number;
  usedKb: number;
  percent: number;
}

/** 提取可读的错误信息 */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
