/**
 * 界面布局偏好的持久化。
 *
 * 栏宽、跟随开关这类偏好要跨会话保留，但拖动一次就写一次数据库太浪费，
 * 因此读取在挂载时做一次，写入在交互结束时做一次。
 *
 * 存储介质与主题一致：数据库 `settings` 表优先，localStorage 兜底
 * （浏览器预览环境下没有 Tauri 命令，只能走 localStorage）。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "./api";

export const LAYOUT_KEYS = {
  sidebarWidth: "layout.sidebarWidth",
  sftpWidth: "layout.sftpWidth",
  followCwd: "layout.followCwd",
} as const;

/** 默认栏宽（与 tokens.css 中的 --w-sidebar / --w-sftp 保持一致） */
export const DEFAULT_SIDEBAR_WIDTH = 248;
export const DEFAULT_SFTP_WIDTH = 288;

/** 拖拽时的宽度上下限 */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 460;
export const SFTP_MIN = 220;
export const SFTP_MAX = 640;

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 读取数字设置 */
export async function readNumber(key: string, fallback: number): Promise<number> {
  try {
    const saved = await api.getSetting(key);
    if (saved != null) {
      const n = Number(saved);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    // 数据库读不到就退回 localStorage
  }
  const local = readLocal(key);
  if (local != null) {
    const n = Number(local);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 写入数字设置 */
export async function writeNumber(key: string, value: number): Promise<void> {
  writeLocal(key, String(value));
  try {
    await api.setSetting(key, String(value));
  } catch {
    // 持久化失败不影响本次生效
  }
}

/** 读取布尔设置 */
export async function readBool(key: string, fallback: boolean): Promise<boolean> {
  try {
    const saved = await api.getSetting(key);
    if (saved === "1" || saved === "true") return true;
    if (saved === "0" || saved === "false") return false;
  } catch {
    // 数据库读不到就退回 localStorage
  }
  const local = readLocal(key);
  if (local === "1" || local === "true") return true;
  if (local === "0" || local === "false") return false;
  return fallback;
}

/** 写入布尔设置 */
export async function writeBool(key: string, value: boolean): Promise<void> {
  writeLocal(key, value ? "1" : "0");
  try {
    await api.setSetting(key, value ? "1" : "0");
  } catch {
    // 持久化失败不影响本次生效
  }
}

/**
 * 与数据库同步的数字状态。
 *
 * 返回 `[值, 设值, 落盘]`：拖拽过程中只改内存，松手时再落盘。
 */
export function useStoredNumber(
  key: string,
  fallback: number
): [
  number,
  Dispatch<SetStateAction<number>>,
  (n: number) => void
] {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    let alive = true;
    readNumber(key, fallback).then((n) => {
      if (alive) setValue(n);
    });
    return () => {
      alive = false;
    };
  }, [key, fallback]);

  const persist = useCallback(
    (n: number) => {
      void writeNumber(key, n);
    },
    [key]
  );

  return [value, setValue, persist];
}
