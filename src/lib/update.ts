import { useSyncExternalStore } from "react";
import { api, errorMessage, type UpdateInfo } from "./api";

/** 更新检查失败的分类文案：标题 + 处理建议，detail 由后端给出 */
export interface UpdateFailureDetail {
  /** 稳定分类键，与后端 UpdateFailure.kind 对应 */
  kind: string;
  title: string;
  /** 技术细节，便于排查 */
  detail: string;
  /** 简短处理建议 */
  advice: string;
}

export type UpdatePhase = "idle" | "checking" | "uptodate" | "available" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** 发现的新版本 */
  info: UpdateInfo | null;
  /** 最近一次检查完成的时间戳 */
  checkedAt: number | null;
  failure: UpdateFailureDetail | null;
}

const FAILURE_TEXT: Record<string, { title: string; advice: string }> = {
  timeout: {
    title: "检查更新超时",
    advice:
      "更新源响应太慢。确认服务器可访问后重试；如果系统开了代理，检查代理设置是否放行该地址。",
  },
  unreachable: {
    title: "无法连接更新源",
    advice:
      "检查网络连通性和更新源地址（地址写在安装包里，设置界面改不了）。服务器未监听对应端口时也会落到这里。",
  },
  blocked: {
    title: "连接被拦截",
    advice:
      "TLS 握手或证书校验没有通过，常见于防火墙、代理或公司网络拦截。换一个网络重试，或联系网络管理员放行。",
  },
  http: {
    title: "更新源返回异常状态",
    advice:
      "服务器返回了非 2xx（常见 404/403/5xx），或返回的不是版本清单。确认 latest.json 的路径和静态文件服务配置。",
  },
  json: {
    title: "更新信息格式不对",
    advice:
      "返回内容不是合法 JSON，或缺少 version / platforms 字段。检查 latest.json 内容，并确认服务器返回的 Content-Type 是 application/json。",
  },
  signature: {
    title: "安装包签名校验失败",
    advice:
      "安装包签名与内置公钥不匹配。确认用同一把私钥签名，且 latest.json 里的 signature 是本次生成 .sig 文件的全文（不要截断或换行）。",
  },
  insecure: {
    title: "更新源协议不被允许",
    advice:
      "当前构建只接受 https 端点。给更新源配上有效证书，或在构建时显式开启 dangerousInsecureTransportProtocol（会降低安全性）。",
  },
  target: {
    title: "缺少当前平台的更新条目",
    advice:
      "latest.json 里没有 windows-x86_64 条目，或该条目缺少 signature / url。补齐后重试。",
  },
  uptodate: {
    title: "当前已是最新版本",
    advice: "不需要更新。",
  },
  network: {
    title: "网络请求失败",
    advice: "检查网络与更新源状态后重试。",
  },
  unknown: {
    title: "检查更新失败",
    advice: "可稍后重试；如果持续失败，请根据下面的错误信息排查更新源。",
  },
};

function failurePayload(e: unknown): { kind: string; message: string } {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    const record = e as { kind: unknown; message: unknown };
    return { kind: String(record.kind), message: String(record.message) };
  }
  return { kind: "unknown", message: errorMessage(e) };
}

/** 把后端/命令错误转成可展示的失败描述 */
export function describeUpdateFailure(e: unknown): UpdateFailureDetail {
  const payload = failurePayload(e);
  const text = FAILURE_TEXT[payload.kind] ?? FAILURE_TEXT.unknown;
  return {
    kind: payload.kind in FAILURE_TEXT ? payload.kind : "unknown",
    title: text.title,
    detail: payload.message,
    advice: text.advice,
  };
}

// ---------- 全局状态 ----------
//
// 放在模块级而不是弹层内部：设置弹层关掉再打开，最近一次检查结果还在；
// 同时保证检查中重复点击只发一个请求。

let state: UpdateState = {
  phase: "idle",
  info: null,
  checkedAt: null,
  failure: null,
};

const listeners = new Set<() => void>();

function setState(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 供非 React 代码读取当前状态 */
export function getUpdateState(): UpdateState {
  return state;
}

/** 订阅更新检查状态（组件卸载后自动退订，不会产生 setState 警告） */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, getUpdateState);
}

export type UpdateCheckResult =
  | { status: "available"; info: UpdateInfo }
  | { status: "uptodate" }
  | { status: "error"; failure: UpdateFailureDetail };

let inFlight: Promise<UpdateCheckResult> | null = null;

/**
 * 发起一次更新检查。
 *
 * 已经在检查时直接复用同一个 Promise，不会重复请求网络。
 */
export function requestUpdateCheck(): Promise<UpdateCheckResult> {
  if (inFlight) return inFlight;

  setState({ phase: "checking", failure: null });

  const task = (async (): Promise<UpdateCheckResult> => {
    try {
      const info = await api.checkUpdate();
      if (info) {
        setState({ phase: "available", info, checkedAt: Date.now(), failure: null });
        return { status: "available", info };
      }
      setState({ phase: "uptodate", info: null, checkedAt: Date.now(), failure: null });
      return { status: "uptodate" };
    } catch (e) {
      const failure = describeUpdateFailure(e);
      setState({ phase: "error", failure, checkedAt: Date.now() });
      return { status: "error", failure };
    } finally {
      inFlight = null;
    }
  })();

  inFlight = task;
  return task;
}

/** 字节数显示；null 表示未知 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "未知";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
