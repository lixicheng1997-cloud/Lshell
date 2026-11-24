/**
 * 全局设置注册表。
 *
 * 设置的读取、校验、落盘全部收敛到这里：
 * - 数据库 `settings` 表是唯一持久化位置，键名见下方的 STORAGE_KEYS；
 * - localStorage 只作为首屏同步副本（终端挂载时不能等异步读取），由本模块统一写入；
 * - 保留旧键 `theme`、`layout.*`，不做 schema 迁移。
 *
 * 使用方式：
 * - 初始化：`await initSettings()`（启动时调用一次，会同步应用主题）
 * - 读取：组件里 `useSettings()`，非组件里 `getSettings()`
 * - 局部即时修改：`updateSetting(key, value)`（例如 Ctrl+滚轮缩放字号）
 * - 设置弹层：`commitSettings(draft, resetKeys)`，保存时才一次性写入并应用
 */
import { useSyncExternalStore } from "react";
import { api } from "./api";
import { applyTheme } from "./theme";
import { uiFontStack } from "./fonts";
import {
  DEFAULT_THEME_ID,
  isThemeId,
  legacyThemeToId,
  parseThemeOpacity,
  resolveTheme,
  themeOpacityKey,
  type ThemeOpacity,
} from "./app-themes";

// ---------- 类型 ----------

export type CursorStyle = "block" | "underline" | "bar";
export type RightClickAction = "paste" | "none";
export type OverwritePolicy = "overwrite" | "skip";
export type BackgroundFit = "cover" | "contain" | "tile";

export interface Settings {
  /** 统一主题 id（见 app-themes.ts），同时决定应用界面与终端配色 */
  theme: string;
  /** 界面字体与主题插画 */
  appearance: {
    /** 界面字体 id，见 fonts.ts */
    uiFont: string;
    /** theme = 跟随主题推荐；custom = 使用 uiFont */
    fontMode: "theme" | "custom";
    /** 是否显示主题自带插画 */
    artworkEnabled: boolean;
    /**
     * 每套主题单独的浓度覆盖，JSON 字符串。
     * 形如 {"starry-book:dark":{"artwork":0.4,"panel":0.85}}；
     * 缺失的键沿用主题自带值，切换主题时互不影响。
     */
    themeOpacity: string;
  };
  /** 主机库宽度 */
  sidebarWidth: number;
  /** 文件面板宽度 */
  sftpWidth: number;
  /** 文件面板是否跟随终端目录 */
  followCwd: boolean;
  terminal: {
    fontFamily: string;
    /** 终端中文是否跟随界面字体 */
    fontFollowsUi: boolean;
    fontSize: number;
    cursorStyle: CursorStyle;
    /** 光标是否闪烁 */
    cursorBlink: boolean;
    /** 回滚缓冲行数 */
    scrollback: number;
    /** 右键行为：直接粘贴 / 不响应 */
    rightClick: RightClickAction;
    /** 整个应用界面的背景图（已复制到应用数据目录的绝对路径），空串表示纯色背景 */
    backgroundImage: string;
    /** 背景图不透明度：越低文字越清晰 */
    backgroundOpacity: number;
    /** 背景图填充方式 */
    backgroundFit: BackgroundFit;
    /** 背景图模糊半径（px） */
    backgroundBlur: number;
  };
  connection: {
    /** 建连超时（秒），对新建连接生效 */
    timeoutSec: number;
    /** 断线后是否自动重连，对已建立会话生效 */
    autoReconnect: boolean;
    /** 新建主机时的默认端口 */
    defaultPort: number;
  };
  transfer: {
    /** 目标已存在时的处理方式 */
    overwrite: OverwritePolicy;
  };
  status: {
    /** 状态栏网速 */
    net: boolean;
    /** 状态栏 CPU/内存等硬件指标 */
    metrics: boolean;
    /** 状态栏挂载磁盘占用 */
    disk: boolean;
  };
  history: {
    /** 是否记录命令历史 */
    enabled: boolean;
  };
  behavior: {
    /** 关闭窗口时最小化到托盘，SSH 会话保留在后台 */
    closeToTray: boolean;
  };
}

/** 所有可配置项的扁平键（点号表示分组） */
export type SettingsKey =
  | "theme"
  | "appearance.uiFont"
  | "appearance.fontMode"
  | "appearance.artworkEnabled"
  | "appearance.themeOpacity"
  | "sidebarWidth"
  | "sftpWidth"
  | "followCwd"
  | "terminal.fontFamily"
  | "terminal.fontFollowsUi"
  | "terminal.fontSize"
  | "terminal.cursorStyle"
  | "terminal.cursorBlink"
  | "terminal.scrollback"
  | "terminal.rightClick"
  | "terminal.backgroundImage"
  | "terminal.backgroundOpacity"
  | "terminal.backgroundFit"
  | "terminal.backgroundBlur"
  | "connection.timeoutSec"
  | "connection.autoReconnect"
  | "connection.defaultPort"
  | "transfer.overwrite"
  | "status.net"
  | "status.metrics"
  | "status.disk"
  | "history.enabled"
  | "behavior.closeToTray";

// ---------- 默认值与范围 ----------

export const TERM_FONT_MIN = 8;
export const TERM_FONT_MAX = 32;
export const DEFAULT_SIDEBAR_WIDTH = 248;
export const DEFAULT_SFTP_WIDTH = 288;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 460;
export const SFTP_MIN = 220;
export const SFTP_MAX = 640;

export const DEFAULT_TERM_FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace';

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME_ID,
  appearance: {
    uiFont: "system",
    fontMode: "theme",
    artworkEnabled: true,
    themeOpacity: "{}",
  },
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sftpWidth: DEFAULT_SFTP_WIDTH,
  followCwd: true,
  terminal: {
    fontFamily: DEFAULT_TERM_FONT_FAMILY,
    /** 终端中文是否跟随界面字体（英文数字仍用等宽字体保证列对齐） */
    fontFollowsUi: false,
    fontSize: 13,
    cursorStyle: "block",
    cursorBlink: true,
    scrollback: 10000,
    rightClick: "paste",
    backgroundImage: "",
    backgroundOpacity: 0.35,
    backgroundFit: "cover",
    backgroundBlur: 0,
  },
  connection: {
    timeoutSec: 15,
    autoReconnect: true,
    defaultPort: 22,
  },
  transfer: {
    overwrite: "overwrite",
  },
  status: {
    net: true,
    metrics: true,
    disk: true,
  },
  history: {
    enabled: true,
  },
  behavior: {
    closeToTray: true,
  },
};

/** 设置键 → 数据库/localStorage 键（旧键名保持不变） */
export const STORAGE_KEYS: Record<SettingsKey, string> = {
  theme: "theme",
  "appearance.uiFont": "ui.fontFamily",
  "appearance.fontMode": "ui.fontMode",
  "appearance.artworkEnabled": "ui.artworkEnabled",
  "appearance.themeOpacity": "ui.themeOpacity",
  sidebarWidth: "layout.sidebarWidth",
  sftpWidth: "layout.sftpWidth",
  followCwd: "layout.followCwd",
  "terminal.fontFamily": "term.fontFamily",
  "terminal.fontFollowsUi": "term.fontFollowsUi",
  "terminal.fontSize": "layout.termFontSize",
  "terminal.cursorStyle": "term.cursorStyle",
  "terminal.cursorBlink": "term.cursorBlink",
  "terminal.scrollback": "term.scrollback",
  "terminal.rightClick": "term.rightClick",
  "terminal.backgroundImage": "term.backgroundImage",
  "terminal.backgroundOpacity": "term.backgroundOpacity",
  "terminal.backgroundFit": "term.backgroundFit",
  "terminal.backgroundBlur": "term.backgroundBlur",
  "connection.timeoutSec": "conn.timeoutSec",
  "connection.autoReconnect": "conn.autoReconnect",
  "connection.defaultPort": "conn.defaultPort",
  "transfer.overwrite": "transfer.overwrite",
  "status.net": "status.net",
  "status.metrics": "status.metrics",
  "status.disk": "status.disk",
  "history.enabled": "history.enabled",
  "behavior.closeToTray": "behavior.closeToTray",
};

export const SETTINGS_KEYS = Object.keys(STORAGE_KEYS) as SettingsKey[];

/** 旧版本终端配色键：只在迁移时读取，之后删除 */
const LEGACY_SCHEME_KEY = "term.colorScheme";

/** 数字项的合法区间；超出区间一律夹取，避免手输脏值 */
const NUM_RANGES: Partial<Record<SettingsKey, [number, number]>> = {
  sidebarWidth: [SIDEBAR_MIN, SIDEBAR_MAX],
  sftpWidth: [SFTP_MIN, SFTP_MAX],
  "terminal.fontSize": [TERM_FONT_MIN, TERM_FONT_MAX],
  "terminal.scrollback": [1000, 50000],
  "terminal.backgroundOpacity": [0.05, 1],

  "terminal.backgroundBlur": [0, 24],
  "connection.timeoutSec": [5, 120],
  "connection.defaultPort": [1, 65535],
};

/** 允许小数的数字项：其余按整数取整 */
const FRACTIONAL_KEYS = new Set<SettingsKey>(["terminal.backgroundOpacity"]);

// ---------- 内部工具 ----------

function cloneDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance },
    terminal: { ...DEFAULT_SETTINGS.terminal },
    connection: { ...DEFAULT_SETTINGS.connection },
    transfer: { ...DEFAULT_SETTINGS.transfer },
    status: { ...DEFAULT_SETTINGS.status },
    history: { ...DEFAULT_SETTINGS.history },
    behavior: { ...DEFAULT_SETTINGS.behavior },
  };
}

/** 读取点号路径上的值 */
function getAt(source: Settings, key: SettingsKey): unknown {
  const parts = key.split(".");
  let cursor: unknown = source;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** 写点号路径上的值，返回新的设置对象 */
function setAt(source: Settings, key: SettingsKey, value: unknown): Settings {
  const parts = key.split(".");
  if (parts.length === 1) {
    return { ...source, [parts[0]]: value } as Settings;
  }
  const [group, field] = parts;
  return {
    ...source,
    [group]: {
      ...(source as unknown as Record<string, Record<string, unknown>>)[group],
      [field]: value,
    },
  } as Settings;
}

function readLocal(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeLocal(storageKey: string, value: string) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // localStorage 不可用时忽略
  }
}

function removeLocal(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // 忽略
  }
}

/** 把数据库/本地存储里的字符串解析成带类型、带范围的值 */
function parseValue(key: SettingsKey, raw: string): string | number | boolean {
  const def = getAt(DEFAULT_SETTINGS, key) as string | number | boolean;
  if (typeof def === "boolean") {
    return raw === "1" || raw === "true";
  }
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    const range = NUM_RANGES[key];
    if (!range) return n;
    const clamped = Math.min(range[1], Math.max(range[0], n));
    return FRACTIONAL_KEYS.has(key)
      ? Math.round(clamped * 100) / 100
      : Math.round(clamped);
  }

  switch (key) {
    case "theme":
      return isThemeId(raw) ? raw : def;
    case "appearance.fontMode":
      return raw === "theme" || raw === "custom" ? raw : def;
    case "appearance.themeOpacity":
      // 只保留可解析的 JSON，脏数据直接回落成空覆盖表
      return parseThemeOpacity(raw) ? raw : def;
    case "terminal.cursorStyle":
      return raw === "block" || raw === "underline" || raw === "bar"
        ? raw
        : def;
    case "terminal.rightClick":
      return raw === "paste" || raw === "none" ? raw : def;
    case "terminal.backgroundFit":
      return raw === "cover" || raw === "contain" || raw === "tile"
        ? raw
        : def;
    case "transfer.overwrite":
      return raw === "overwrite" || raw === "skip" ? raw : def;
    default:
      return raw;
  }
}

function serializeValue(key: SettingsKey, value: unknown): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (key === "terminal.fontFamily") return String(value);
  return String(value);
}

/** 首屏同步读取：以 localStorage 副本为基线（顺便迁移旧主题值） */
function readCached(): Settings {
  let settings = cloneDefaults();
  for (const key of SETTINGS_KEYS) {
    const raw = readLocal(STORAGE_KEYS[key]);
    if (raw == null) continue;
    settings = setAt(settings, key, parseValue(key, raw));
  }

  // 旧版本把主题拆成 theme(深/浅/系统) + term.colorScheme，
  // 这里在首屏就把它们合成统一主题 id，避免白屏或配色错乱
  const legacyScheme = readLocal(LEGACY_SCHEME_KEY);
  const themeId = legacyThemeToId(
    readLocal(STORAGE_KEYS.theme),
    legacyScheme
  );
  settings = setAt(settings, "theme", themeId);
  writeLocal(STORAGE_KEYS.theme, themeId);
  if (legacyScheme != null) removeLocal(LEGACY_SCHEME_KEY);
  return settings;
}

let current: Settings = readCached();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/**
 * 取当前主题的浓度覆盖。
 *
 * 键是「族:深浅」，同一族的两套主题互不干扰；
 * 未覆盖的项返回 undefined，表示沿用主题自带值。
 */
export function currentThemeOpacity(): ThemeOpacity {
  const theme = resolveTheme(current.theme);
  const table = parseThemeOpacity(current.appearance.themeOpacity);
  return table[themeOpacityKey(theme)] ?? {};
}

/**
 * 当前生效的界面字体栈。
 *
 * 手动指定时用用户选的那款，否则用主题推荐；
 * 终端的「跟随界面字体」也取这个值。
 */
export function effectiveUiFontStack(): string {
  if (current.appearance.fontMode === "custom") {
    return uiFontStack(current.appearance.uiFont);
  }
  const theme = resolveTheme(current.theme);
  return theme.fonts?.ui ?? uiFontStack("system");
}

/** 应用当前主题：字体按模式决定，其余浓度取当前主题的覆盖值 */
function applyCurrentTheme() {
  const opacity = currentThemeOpacity();
  applyTheme(
    current.theme,
    current.appearance.fontMode === "custom"
      ? current.appearance.uiFont
      : undefined,
    opacity.panel
  );
}

/** 把当前值写入 localStorage 副本，保证下次首屏同步读取到最新值 */
function mirrorAll() {
  for (const key of SETTINGS_KEYS) {
    writeLocal(STORAGE_KEYS[key], serializeValue(key, getAt(current, key)));
  }
}

// ---------- 对外接口 ----------

/** 启动时初始化：先应用缓存主题避免闪屏，再从数据库补齐 */
export async function initSettings(): Promise<Settings> {
  applyCurrentTheme();

  try {
    const all = await api.getAllSettings();
    let next = current;
    for (const key of SETTINGS_KEYS) {
      const raw = all[STORAGE_KEYS[key]];
      if (raw == null) continue;
      next = setAt(next, key, parseValue(key, raw));
    }

    // 数据库里可能还留着旧版本的 term.colorScheme：
    // 选了具体方案就升级成同名的统一主题，然后删掉旧键
    const legacyScheme = all[LEGACY_SCHEME_KEY];
    const storedTheme = all[STORAGE_KEYS.theme];
    if (storedTheme != null || legacyScheme != null) {
      const migrated = legacyThemeToId(storedTheme, legacyScheme);
      next = setAt(next, "theme", migrated);
      if (legacyScheme != null) {
        if (migrated !== storedTheme) {
          api.setSetting(STORAGE_KEYS.theme, migrated).catch(() => {});
        }
        api.deleteSetting(LEGACY_SCHEME_KEY).catch(() => {});
        writeLocal(STORAGE_KEYS.theme, migrated);
      } else if (migrated !== storedTheme) {
        api.setSetting(STORAGE_KEYS.theme, migrated).catch(() => {});
      }
    }
    current = next;
  } catch {
    // 浏览器预览 / 命令缺失时保持 localStorage 副本
  }

  applyCurrentTheme();
  mirrorAll();
  notify();
  return current;
}

export function getSettings(): Settings {
  return current;
}

export function getSettingValue(key: SettingsKey): unknown {
  return getAt(current, key);
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}

/** 修改一项设置：立即生效 + 异步落盘（仅用于终端内 Ctrl+滚轮这类局部交互） */
export function updateSetting(
  key: SettingsKey,
  value: string | number | boolean
): void {
  const parsed = parseValue(key, serializeValue(key, value));
  current = setAt(current, key, parsed);
  if (key === "theme" || key.startsWith("appearance.")) applyCurrentTheme();
  writeLocal(STORAGE_KEYS[key], serializeValue(key, parsed));
  notify();
  api.setSetting(STORAGE_KEYS[key], serializeValue(key, parsed)).catch(() => {
    // 持久化失败不影响本次生效
  });
}

// ---------- 草稿与保存 ----------

/** 深拷贝设置对象，供设置弹层编辑草稿时使用 */
export function cloneSettings(source: Settings = current): Settings {
  return {
    ...source,
    appearance: { ...source.appearance },
    terminal: { ...source.terminal },
    connection: { ...source.connection },
    transfer: { ...source.transfer },
    status: { ...source.status },
    history: { ...source.history },
    behavior: { ...source.behavior },
  };
}

/** 读取某一项的注册表默认值 */
export function getDefaultSetting(key: SettingsKey): string | number | boolean {
  return getAt(DEFAULT_SETTINGS, key) as string | number | boolean;
}

/** 返回修改了某一项后的新设置对象（不修改原对象，不落盘） */
export function withSetting(
  source: Settings,
  key: SettingsKey,
  value: string | number | boolean
): Settings {
  const parsed = parseValue(key, serializeValue(key, value));
  return setAt(cloneSettings(source), key, parsed);
}

/** 比较两份设置是否完全一致 */
export function settingsEqual(a: Settings, b: Settings): boolean {
  return SETTINGS_KEYS.every((key) => getAt(a, key) === getAt(b, key));
}

/**
 * 保存草稿：一次性写入变更项，删除 `resetKeys` 中的数据库键，然后统一广播。
 *
 * 与 `updateSetting` 的区别是「先改完再落盘」：
 * 弹层里的所有修改（含主题、字体字号）都在这里才真正生效，
 * 中途关闭弹层不会留下任何写入。
 */
export async function commitSettings(
  draft: Settings,
  resetKeys: SettingsKey[] = []
): Promise<SettingsKey[]> {
  const previous = current;
  const next = cloneSettings(draft);
  const reset = new Set(resetKeys);
  const changed: SettingsKey[] = [];
  const writes: Promise<unknown>[] = [];

  for (const key of SETTINGS_KEYS) {
    const before = getAt(previous, key);
    const after = getAt(next, key);

    if (reset.has(key)) {
      // 「恢复本页默认」只有在点保存时才真正删除数据库键
      removeLocal(STORAGE_KEYS[key]);
      writes.push(api.deleteSetting(STORAGE_KEYS[key]).catch(() => {}));
      if (before !== after) changed.push(key);
      continue;
    }

    if (before === after) continue;
    const serialized = serializeValue(key, after);
    writeLocal(STORAGE_KEYS[key], serialized);
    writes.push(api.setSetting(STORAGE_KEYS[key], serialized).catch(() => {}));
    changed.push(key);
  }

  current = next;
  if (changed.some((key) => key === "theme" || key.startsWith("appearance."))) applyCurrentTheme();
  notify();

  await Promise.all(writes);
  return changed;
}
