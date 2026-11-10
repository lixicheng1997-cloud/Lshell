/**
 * 布局偏好的兼容层。
 *
 * 历史原因，栏宽/字号等读写函数散落在这里。现在持久化统一走 settings.ts，
 * 本文件只保留原有导出签名，避免调用方大面积改动。
 */
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  TERM_FONT_MAX as REGISTRY_TERM_FONT_MAX,
  TERM_FONT_MIN as REGISTRY_TERM_FONT_MIN,
  getSettingValue,
  getSettings,
  updateSetting,
  useSettings,
  type SettingsKey,
} from "./settings";

/** 默认栏宽、拖拽区间与字号区间统一由注册表提供 */
export {
  DEFAULT_SFTP_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  SFTP_MAX,
  SFTP_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "./settings";

export const LAYOUT_KEYS = {
  sidebarWidth: STORAGE_KEYS.sidebarWidth,
  sftpWidth: STORAGE_KEYS.sftpWidth,
  followCwd: STORAGE_KEYS.followCwd,
  termFontSize: STORAGE_KEYS["terminal.fontSize"],
} as const;

/** 终端字号默认值与 Ctrl+滚轮缩放区间 */
export const DEFAULT_TERM_FONT_SIZE = DEFAULT_SETTINGS.terminal.fontSize;
export const TERM_FONT_MIN = REGISTRY_TERM_FONT_MIN;
export const TERM_FONT_MAX = REGISTRY_TERM_FONT_MAX;

const KEY_BY_STORAGE = Object.fromEntries(
  (Object.keys(STORAGE_KEYS) as SettingsKey[]).map((key) => [
    STORAGE_KEYS[key],
    key,
  ])
) as Record<string, SettingsKey>;

function toSettingsKey(storageKey: string): SettingsKey | undefined {
  return KEY_BY_STORAGE[storageKey];
}

/**
 * 同步读取终端字号。
 *
 * 终端挂载时不能等异步的数据库读取（会先闪一下默认字号），
 * 因此注册表在模块加载时就用 localStorage 副本构建好了当前值。
 */
export function readTermFontSizeSync(): number {
  return getSettings().terminal.fontSize;
}

/** 读取数字设置 */
export async function readNumber(
  key: string,
  fallback: number
): Promise<number> {
  const settingsKey = toSettingsKey(key);
  if (!settingsKey) return fallback;
  const value = getSettingValue(settingsKey);
  return typeof value === "number" ? value : fallback;
}

/** 写入数字设置 */
export async function writeNumber(key: string, value: number): Promise<void> {
  const settingsKey = toSettingsKey(key);
  if (settingsKey) updateSetting(settingsKey, value);
}

/** 读取布尔设置 */
export async function readBool(
  key: string,
  fallback: boolean
): Promise<boolean> {
  const settingsKey = toSettingsKey(key);
  if (!settingsKey) return fallback;
  const value = getSettingValue(settingsKey);
  return typeof value === "boolean" ? value : fallback;
}

/** 写入布尔设置 */
export async function writeBool(key: string, value: boolean): Promise<void> {
  const settingsKey = toSettingsKey(key);
  if (settingsKey) updateSetting(settingsKey, value);
}

/**
 * 与注册表同步的数字状态。
 *
 * 返回 `[值, 设值, 落盘]`：拖拽过程中只改内存，松手时再落盘。
 */
export function useStoredNumber(
  key: string,
  fallback: number
): [number, Dispatch<SetStateAction<number>>, (n: number) => void] {
  useSettings();
  const settingsKey = toSettingsKey(key);
  const storedValue = settingsKey
    ? (getSettingValue(settingsKey) as number)
    : fallback;

  // 拖拽过程中的临时值；落盘后清空，回到注册表值
  const [draft, setDraft] = useState<number | null>(null);

  useEffect(() => {
    setDraft(null);
  }, [storedValue]);

  const setValue = useCallback<Dispatch<SetStateAction<number>>>(
    (action) => {
      setDraft((prev) => {
        const base = prev ?? storedValue;
        return typeof action === "function"
          ? (action as (n: number) => number)(base)
          : action;
      });
    },
    [storedValue]
  );

  const persist = useCallback(
    (n: number) => {
      if (settingsKey) updateSetting(settingsKey, n);
    },
    [settingsKey]
  );

  return [draft ?? storedValue, setValue, persist];
}
