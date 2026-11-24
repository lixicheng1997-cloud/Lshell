import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { api, errorMessage, type UpdateInfo } from "../lib/api";
import { useDialogFocus } from "../lib/dialog";
import {
  formatBytes,
  requestUpdateCheck,
  useUpdateState,
} from "../lib/update";
import { useShortcuts } from "../lib/shortcuts";
import { notify } from "../lib/toast";
import type { KnownHost } from "../lib/types";
import {
  DEFAULT_TERM_FONT_FAMILY,
  TERM_FONT_MAX,
  TERM_FONT_MIN,
  cloneSettings,
  commitSettings,
  getDefaultSetting,
  getSettings,
  settingsEqual,
  withSetting,
  type BackgroundFit,
  type CursorStyle,
  type OverwritePolicy,
  type RightClickAction,
  type Settings,
  type SettingsKey,
} from "../lib/settings";
import {
  THEME_OPTIONS,
  parseThemeOpacity,
  resolveTheme,
  shapeOf,
  themeArtwork,
  themeOpacityKey,
  themeSwatches,
} from "../lib/app-themes";
import { UI_FONT_OPTIONS } from "../lib/fonts";
import Icon from "./Icon";

type PageId =
  | "appearance"
  | "terminal"
  | "connection"
  | "transfer"
  | "statusbar"
  | "diagnostics";

const PAGES: { id: PageId; title: string }[] = [
  { id: "appearance", title: "主题与背景" },
  { id: "terminal", title: "终端" },
  { id: "connection", title: "连接" },
  { id: "transfer", title: "传输" },
  { id: "statusbar", title: "状态栏" },
  { id: "diagnostics", title: "安全与诊断" },
];

interface Props {
  onClose: () => void;
  /** 更新功能是否开启（后端 updater::FEATURE_ENABLED 决定） */
  updateEnabled?: boolean;
  /** 打开现有的更新弹层（下载/安装流程复用 UpdateDialog） */
  onShowUpdate: (info: UpdateInfo) => void;
}

interface PageProps {
  draft: Settings;
  onChange: (key: SettingsKey, value: string | number | boolean) => void;
  onReset: (keys: SettingsKey[]) => void;
  updateEnabled?: boolean;
  onShowUpdate?: (info: UpdateInfo) => void;
}

// ---------- 通用控件 ----------

/**
 * 当前卡片标题。
 *
 * 行标签与卡片标题重复时（区块只有一行时最常见）自动省略标签列，
 * 避免出现「主题与背景 → 主题 → 主题」这种层层重复的读法。
 */
const SectionTitleContext = createContext<string | null>(null);

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card">
      <SectionTitleContext.Provider value={title}>
        <h3 className="settings-card-title">{title}</h3>
        <div className="settings-card-body">{children}</div>
      </SectionTitleContext.Provider>
    </section>
  );
}

function Row({
  label,
  desc,
  children,
  block,
}: {
  label: string;
  desc?: ReactNode;
  children: ReactNode;
  /** 整行铺开：标签独占一行，控件占满宽度（用于主题网格这类宽内容） */
  block?: boolean;
}) {
  const sectionTitle = useContext(SectionTitleContext);
  // 标签与卡片标题重复时省略标签列，控件直接铺满
  const hideLabel = sectionTitle === label;
  return (
    <div
      className={`settings-row ${block ? "block" : ""} ${hideLabel ? "nolabel" : ""}`}
    >
      {hideLabel ? null : <div className="label">{label}</div>}
      <div className="control">{children}</div>
      {desc ? <div className="settings-desc">{desc}</div> : null}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg-switch">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "on" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track">
        <span className="thumb" />
      </span>
    </label>
  );
}

function NumberInput({
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <>
      <input
        type="number"
        className="num-input"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {suffix ? <span className="settings-unit">{suffix}</span> : null}
    </>
  );
}

function RangeInput({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="range"
      className="settings-range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function ResetButton({
  keys,
  onReset,
}: {
  keys: SettingsKey[];
  onReset: (keys: SettingsKey[]) => void;
}) {
  return (
    <div className="settings-page-footer">
      <button type="button" className="btn" onClick={() => onReset(keys)}>
        恢复本页默认
      </button>
    </div>
  );
}

// ---------- 字体选择 ----------

interface FontOption {
  label: string;
  value: string;
}

/**
 * 内置等宽字体。
 *
 * 每个取值都是「首选字体 + 后备栈」：系统没装首选字体时，
 * 浏览器会自动回落到 Consolas / monospace，不会出现异常字形。
 */
const FONT_OPTIONS: FontOption[] = [
  {
    label: "Cascadia Code",
    value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  },
  // 与历史默认值保持一致，避免已有用户被判定成「自定义」
  { label: "Cascadia Mono", value: DEFAULT_TERM_FONT_FAMILY },
  {
    label: "JetBrains Mono",
    value: '"JetBrains Mono", Consolas, monospace',
  },
  { label: "Fira Code", value: '"Fira Code", Consolas, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", Consolas, monospace' },
  { label: "IBM Plex Mono", value: '"IBM Plex Mono", Consolas, monospace' },
  { label: "Hack", value: "Hack, Consolas, monospace" },
  { label: "Consolas", value: "Consolas, monospace" },
  {
    label: "DejaVu Sans Mono",
    value: '"DejaVu Sans Mono", Consolas, monospace',
  },
  { label: "Ubuntu Mono", value: '"Ubuntu Mono", Consolas, monospace' },
  { label: "Menlo", value: "Menlo, Consolas, monospace" },
  { label: "Monaco", value: "Monaco, Consolas, monospace" },
  // 内置等宽中文：中英 2:1 精确对齐，终端表格不会错位
  {
    label: "等宽可爱（快乐体）",
    value: '"Lshell Mono KuaiLe", "ZCOOL KuaiLe", "Microsoft YaHei UI", monospace',
  },
  {
    label: "等宽可爱（小薇体）",
    value: '"Lshell Mono XiaoWei", "ZCOOL XiaoWei", "Microsoft YaHei UI", monospace',
  },
  { label: "monospace（兜底）", value: "monospace" },
];

const FONT_SAMPLE = "const $ ls -la";

/** 界面字体预览文本：固定文案，且不能包含任何选项名，避免误选 */
const UI_FONT_SAMPLE = "字体预览 Aa 123";

function firstFamily(value: string): string {
  return value.split(",")[0]?.trim() || "monospace";
}

function FontSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  // 检测字体是否可用；结果只用于标注，实际渲染始终有后备栈
  useEffect(() => {
    let alive = true;
    const check = () => {
      const next: Record<string, boolean> = {};
      for (const option of FONT_OPTIONS) {
        try {
          next[option.value] = document.fonts.check(
            `13px ${firstFamily(option.value)}`
          );
        } catch {
          next[option.value] = true;
        }
      }
      if (alive) setInstalled(next);
    };
    check();
    document.fonts.ready.then(check).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const options = useMemo(() => {
    // 数据库里如果存着列表之外的旧值，保留并显示为当前值
    if (value && !FONT_OPTIONS.some((option) => option.value === value)) {
      return [{ label: `自定义：${value}`, value }, ...FONT_OPTIONS];
    }
    return FONT_OPTIONS;
  }, [value]);

  const current =
    options.find((option) => option.value === value) ??
    (value ? { label: `自定义：${value}`, value } : options[0]);

  return (
    <div className="font-select" ref={rootRef}>
      <button
        type="button"
        className="font-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value}
      >
        <span className="font-trigger-name" style={{ fontFamily: value }}>
          {current.label}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="font-menu" role="listbox">
          {options.map((option) => {
            const uninstalled =
              !option.label.startsWith("自定义") &&
              option.value !== "monospace" &&
              installed[option.value] === false;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`font-option ${option.value === value ? "on" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="font-option-main">
                  <span className="font-option-name">{option.label}</span>
                  {uninstalled && (
                    <span className="font-badge">未安装</span>
                  )}
                </span>
                <span
                  className="font-option-sample"
                  style={{ fontFamily: option.value }}
                >
                  {FONT_SAMPLE}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- 主题下拉 ----------

/**
 * 主题平铺选择。
 *
 * 展示全部定制主题；每张卡片直接用主题插画或色板做预览，
 * 点击即选中，不再需要展开下拉菜单。
 */
function ThemeGrid({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="theme-grid" role="radiogroup" aria-label="主题">
      {THEME_OPTIONS.map((option) => {
        const theme = resolveTheme(option.id);
        const art = themeArtwork(theme);
        const swatches = themeSwatches(theme);
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`theme-card ${selected ? "on" : ""}`}
            onClick={() => onChange(option.id)}
          >
            <span
              className="theme-card-preview"
              style={
                art
                  ? {
                      backgroundImage: `url("${art.src}")`,
                      backgroundColor: swatches[0],
                    }
                  : {
                      backgroundImage: `linear-gradient(135deg, ${swatches[0]} 0%, ${swatches[2]} 100%)`,
                    }
              }
              aria-hidden
            >
              <span className="theme-card-swatches">
                {swatches.map((color, index) => (
                  <span key={index} style={{ background: color }} />
                ))}
              </span>
            </span>
            <span className="theme-card-label">
              <span className="theme-card-name">{option.name}</span>
              <span className="theme-badge">
                {theme.mode === "light" ? "浅色" : "深色"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------- 界面字体与主题插画 ----------

/**
 * 每套主题各自的浓度设置。
 *
 * 覆盖表以「族:深浅」为键，同一族的深浅主题互不干扰；
 * 滑块直接显示当前主题的生效值（覆盖值优先，否则用主题自带值）。
 */
function ThemeOpacityRows({
  draft,
  onChange,
}: {
  draft: Settings;
  onChange: (key: SettingsKey, value: string | number | boolean) => void;
}) {
  const theme = resolveTheme(draft.theme);
  const key = themeOpacityKey(theme);
  const table = parseThemeOpacity(draft.appearance.themeOpacity);
  const override = table[key] ?? {};
  const artwork = themeArtwork(theme);
  const defaultArtwork = artwork?.opacity ?? 1;
  const defaultPanel = shapeOf(theme).veil;

  const write = (patch: { artwork?: number; panel?: number }) => {
    const next = { ...table };
    const merged = { ...override, ...patch };
    // 数值与主题默认值相同时删掉该键，保持覆盖表干净
    if (
      merged.artwork === undefined ||
      Math.abs(merged.artwork - defaultArtwork) < 0.001
    ) {
      delete merged.artwork;
    }
    if (
      merged.panel === undefined ||
      Math.abs(merged.panel - defaultPanel) < 0.001
    ) {
      delete merged.panel;
    }
    if (merged.artwork === undefined && merged.panel === undefined) {
      delete next[key];
    } else {
      next[key] = merged;
    }
    onChange("appearance.themeOpacity", JSON.stringify(next));
  };

  return (
    <>
      <Row
        label="插画浓度"
        desc={`当前主题「${theme.name}」背景插画的浓度，数值越低插画越淡；每套主题单独记忆`}
      >
        <RangeInput
          value={override.artwork ?? defaultArtwork}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => write({ artwork: v })}
        />
        <span className="settings-unit">
          {Math.round((override.artwork ?? defaultArtwork) * 100)}%
        </span>
        {override.artwork === undefined ? (
          <span className="settings-unit">默认</span>
        ) : null}
      </Row>
      <Row
        label="面板浓度"
        desc={`背景上各面板的浓度，越不透明文字越清晰；每套主题单独记忆`}
      >
        <RangeInput
          value={override.panel ?? defaultPanel}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => write({ panel: v })}
        />
        <span className="settings-unit">
          {Math.round((override.panel ?? defaultPanel) * 100)}%
        </span>
        {override.panel === undefined ? (
          <span className="settings-unit">默认</span>
        ) : null}
      </Row>
    </>
  );
}

/**
 * 界面字体选择器。
 *
 * 用下拉卡片而不是原生 select：能直接预览字体效果，
 * 也能标出「已内置 / 未安装」，避免选了却看不出变化。
 */
function UiFontSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const current =
    UI_FONT_OPTIONS.find((option) => option.id === value) ??
    UI_FONT_OPTIONS[0];

  return (
    <div className="font-select" ref={rootRef}>
      <button
        type="button"
        className="font-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="font-trigger-name" style={{ fontFamily: current.stack }}>
          {current.label}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="font-menu" role="listbox">
          {UI_FONT_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === value}
              className={`font-option ${option.id === value ? "on" : ""}`}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <span className="font-option-main">
                <span className="font-option-name">{option.label}</span>
                {option.bundled ? (
                  <span className="font-badge">已内置</span>
                ) : null}
              </span>
              <span
                className="font-option-sample"
                style={{ fontFamily: option.stack }}
              >
                {UI_FONT_SAMPLE}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AppearanceExtras({
  draft,
  onChange,
}: {
  draft: Settings;
  onChange: (key: SettingsKey, value: string | number | boolean) => void;
}) {
  const { fontMode, uiFont, artworkEnabled } = draft.appearance;
  return (
    <Section title="界面字体与插画">
      <Row label="字体模式" desc="跟随主题时使用主题推荐字体；手动指定可覆盖">
        <Segmented<"theme" | "custom">
          value={fontMode}
          options={[
            { value: "theme", label: "跟随主题" },
            { value: "custom", label: "手动指定" },
          ]}
          onChange={(v) => onChange("appearance.fontMode", v)}
        />
      </Row>
      {fontMode === "custom" ? (
        <Row
          label="字体选择"
          desc={
            UI_FONT_OPTIONS.find((option) => option.id === uiFont)?.note ??
            "未安装的字体自动回落，不影响界面可读性"
          }
        >
          <UiFontSelect
            value={uiFont}
            onChange={(v) => onChange("appearance.uiFont", v)}
          />
        </Row>
      ) : null}
      <Row label="主题插画" desc="部分主题自带背景插画；用户自定义背景图始终优先">
        <Toggle
          checked={artworkEnabled}
          onChange={(v) => onChange("appearance.artworkEnabled", v)}
        />
      </Row>
      <ThemeOpacityRows draft={draft} onChange={onChange} />
    </Section>
  );
}

// ---------- 背景图 ----------

function BackgroundImageRow({
  value,
  onChange,
  onNewCopy,
}: {
  value: string;
  onChange: (value: string) => void;
  onNewCopy: (path: string) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setMissing(false);
    if (!value) {
      setPreview(null);
      return;
    }
    api
      .terminalBackgroundExists(value)
      .then(async (exists) => {
        if (!alive) return;
        if (!exists) {
          setMissing(true);
          setPreview(null);
          return;
        }
        const url = await api.terminalBackgroundDataUrl(value);
        if (alive) setPreview(url);
      })
      .catch(() => {
        if (!alive) return;
        setMissing(true);
        setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [value]);

  const pick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        title: "选择背景图",
        filters: [
          {
            name: "图片",
            extensions: ["png", "jpg", "jpeg", "webp", "bmp"],
          },
        ],
      });
      if (!picked || typeof picked !== "string") return;
      // 先复制到应用数据目录再引用，用户移动/删除原图不会让背景失效
      const copied = await api.saveTerminalBackground(picked);
      onNewCopy(copied);
      onChange(copied);
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const desc = value
    ? missing
      ? "背景图文件已丢失，请重新选择或清除。"
      : "图片已复制到应用数据目录，原文件移动或删除不影响这里。"
    : "选择本地图片铺在整个应用界面（侧栏、标签栏、终端与状态栏）；未设置时使用主题纯色背景。";

  return (
    <Row label="背景图" desc={desc}>
      <div className="settings-bg">
        <div
          className={`settings-bg-thumb ${preview ? "on" : ""}`}
          style={preview ? { backgroundImage: `url("${preview}")` } : undefined}
        >
          {!preview && (
            <span className="settings-bg-empty">
              {missing ? "文件丢失" : "未设置"}
            </span>
          )}
        </div>
        <button type="button" className="btn" onClick={pick} disabled={busy}>
          {busy ? "复制中…" : value ? "更换图片" : "选择图片"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onChange("")}
          disabled={!value}
        >
          清除
        </button>
      </div>
    </Row>
  );
}

// ---------- 页面 ----------

function AppearancePage({
  draft,
  onChange,
  onReset,
  onNewCopy,
}: PageProps & { onNewCopy: (path: string) => void }) {
  const hasBackground = draft.terminal.backgroundImage !== "";

  return (
    <>
      <Section title="主题">
        <Row
          block
          label="主题"
          desc="一套主题同时定义界面色板与终端 ANSI 配色，保存后应用到整个界面。"
        >
          <ThemeGrid
            value={draft.theme}
            onChange={(v) => onChange("theme", v)}
          />
        </Row>
        <div className="settings-note">
          每套主题同时决定界面与终端配色，并可单独调节背景插画与面板浓度。
        </div>
      </Section>

      <AppearanceExtras draft={draft} onChange={onChange} />

      <Section title="背景图">
        <BackgroundImageRow
          value={draft.terminal.backgroundImage}
          onChange={(v) => onChange("terminal.backgroundImage", v)}
          onNewCopy={onNewCopy}
        />
        <Row
          label="不透明度"
          desc="数值越低文字越清晰；铺图后各面板会叠加主题色半透明底，避免图片影响阅读"
        >
          <RangeInput
            value={draft.terminal.backgroundOpacity}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => onChange("terminal.backgroundOpacity", v)}
          />
          <span className="settings-unit">
            {Math.round(draft.terminal.backgroundOpacity * 100)}%
          </span>
        </Row>
        <Row label="填充方式">
          <Segmented<BackgroundFit>
            value={draft.terminal.backgroundFit}
            options={[
              { value: "cover", label: "覆盖" },
              { value: "contain", label: "完整显示" },
              { value: "tile", label: "平铺" },
            ]}
            onChange={(v) => onChange("terminal.backgroundFit", v)}
          />
        </Row>
        <Row label="模糊" desc="适度模糊有助于压制背景细节，突出前景文字">
          <RangeInput
            value={draft.terminal.backgroundBlur}
            min={0}
            max={24}
            step={1}
            onChange={(v) => onChange("terminal.backgroundBlur", v)}
          />
          <span className="settings-unit">
            {draft.terminal.backgroundBlur}px
          </span>
        </Row>
        {!hasBackground && (
          <div className="settings-hint">
            未选择背景图时以上参数不生效；若当前主题自带插画仍会显示，可在上方关闭。
          </div>
        )}
      </Section>

      <Section title="布局">
        <Row label="侧栏 / 文件面板" desc="宽度仍可直接拖拽调整">
          <button
            type="button"
            className="btn"
            onClick={() => onReset(["sidebarWidth", "sftpWidth"])}
          >
            恢复默认宽度
          </button>
        </Row>
      </Section>

      <ResetButton
        keys={[
          "theme",
          "appearance.uiFont",
          "appearance.fontMode",
          "appearance.artworkEnabled",
          "appearance.themeOpacity",
          "terminal.backgroundImage",
          "terminal.backgroundOpacity",
          "terminal.backgroundFit",
          "terminal.backgroundBlur",
          "sidebarWidth",
          "sftpWidth",
        ]}
        onReset={onReset}
      />
    </>
  );
}

function TerminalPage({ draft, onChange, onReset }: PageProps) {
  return (
    <>
      <Section title="字体">
        <Row label="字体族" desc="未安装的字体会自动回落到 Consolas / monospace">
          <FontSelect
            value={draft.terminal.fontFamily}
            onChange={(v) => onChange("terminal.fontFamily", v)}
          />
        </Row>
        <Row
          label="跟随界面字体"
          desc="开启后终端直接使用界面所选的字体；内置等宽中文字体中英 2:1 对齐，表格不会错位"
        >
          <Toggle
            checked={draft.terminal.fontFollowsUi}
            onChange={(v) => onChange("terminal.fontFollowsUi", v)}
          />
        </Row>
        <Row
          label="字号"
          desc={`${TERM_FONT_MIN}–${TERM_FONT_MAX} px，保存后应用；也可用 Ctrl+滚轮临时缩放`}
        >
          <NumberInput
            value={draft.terminal.fontSize}
            min={TERM_FONT_MIN}
            max={TERM_FONT_MAX}
            suffix="px"
            onChange={(v) => onChange("terminal.fontSize", v)}
          />
        </Row>
      </Section>

      <Section title="光标">
        <Row label="样式">
          <Segmented<CursorStyle>
            value={draft.terminal.cursorStyle}
            options={[
              { value: "block", label: "方块" },
              { value: "bar", label: "竖线" },
              { value: "underline", label: "下划线" },
            ]}
            onChange={(v) => onChange("terminal.cursorStyle", v)}
          />
        </Row>
        <Row label="闪烁">
          <Toggle
            checked={draft.terminal.cursorBlink}
            onChange={(v) => onChange("terminal.cursorBlink", v)}
          />
        </Row>
      </Section>

      <Section title="滚动与鼠标">
        <Row label="回滚行数" desc="超出缓冲区的历史输出会被丢弃">
          <NumberInput
            value={draft.terminal.scrollback}
            min={1000}
            max={50000}
            suffix="行"
            onChange={(v) => onChange("terminal.scrollback", v)}
          />
        </Row>
        <Row label="右键行为" desc="复制请使用 Ctrl+Shift+C">
          <Segmented<RightClickAction>
            value={draft.terminal.rightClick}
            options={[
              { value: "paste", label: "粘贴剪贴板" },
              { value: "none", label: "不响应" },
            ]}
            onChange={(v) => onChange("terminal.rightClick", v)}
          />
        </Row>
      </Section>

      <ResetButton
        keys={[
          "terminal.fontFamily",
          "terminal.fontFollowsUi",
          "terminal.fontSize",
          "terminal.cursorStyle",
          "terminal.cursorBlink",
          "terminal.scrollback",
          "terminal.rightClick",
        ]}
        onReset={onReset}
      />
    </>
  );
}

function ConnectionPage({ draft, onChange, onReset }: PageProps) {
  return (
    <>
      <div className="settings-note">
        建连超时与默认端口对<strong>新建连接</strong>生效，保存后不会改变当前会话；
        自动重连开关对<strong>已建立会话</strong>的断线处理立即生效。
      </div>

      <Section title="连接参数">
        <Row
          label="建连超时"
          desc="超过该时间仍未握手成功则判定失败；新建连接时生效"
        >
          <NumberInput
            value={draft.connection.timeoutSec}
            min={5}
            max={120}
            suffix="秒"
            onChange={(v) => onChange("connection.timeoutSec", v)}
          />
        </Row>
        <Row label="断线自动重连" desc="关闭后断线会直接进入断开状态">
          <Toggle
            checked={draft.connection.autoReconnect}
            onChange={(v) => onChange("connection.autoReconnect", v)}
          />
        </Row>
      </Section>

      <Section title="新建主机默认值">
        <Row label="默认端口" desc="仅影响新建主机的初始端口，不修改已保存主机">
          <NumberInput
            value={draft.connection.defaultPort}
            min={1}
            max={65535}
            onChange={(v) => onChange("connection.defaultPort", v)}
          />
        </Row>
      </Section>

      <ResetButton
        keys={[
          "connection.timeoutSec",
          "connection.autoReconnect",
          "connection.defaultPort",
        ]}
        onReset={onReset}
      />
    </>
  );
}

function TransferPage({ draft, onChange, onReset }: PageProps) {
  return (
    <>
      <div className="settings-note">
        覆盖策略同时作用于上传与下载，保存后立即生效。选择“跳过”时，目标已存在会在
        传输提示里给出跳过原因，不会产生重复传输。
      </div>

      <Section title="覆盖策略">
        <Row
          label="目标已存在"
          desc="覆盖采用临时文件 + 改名，失败不会破坏原文件"
        >
          <Segmented<OverwritePolicy>
            value={draft.transfer.overwrite}
            options={[
              { value: "overwrite", label: "直接覆盖" },
              { value: "skip", label: "跳过" },
            ]}
            onChange={(v) => onChange("transfer.overwrite", v)}
          />
        </Row>
      </Section>

      <ResetButton keys={["transfer.overwrite"]} onReset={onReset} />
    </>
  );
}

function StatusBarPage({ draft, onChange, onReset }: PageProps) {
  return (
    <>
      <div className="settings-note">
        状态栏右侧的连接状态、地址、会话数与终端参数始终显示；以下监控项可单独关闭。
        关闭后对应轮询也会停止，不再占用远端资源。
      </div>

      <Section title="监控项">
        <Row label="网速" desc="终端通道的上下行速率，每 2 秒采样">
          <Toggle
            checked={draft.status.net}
            onChange={(v) => onChange("status.net", v)}
          />
        </Row>
        <Row label="硬件指标" desc="CPU、内存、负载、运行时长，约每 6 秒刷新">
          <Toggle
            checked={draft.status.metrics}
            onChange={(v) => onChange("status.metrics", v)}
          />
        </Row>
        <Row label="挂载磁盘" desc="当前目录所在挂载点的占用，每 60 秒刷新">
          <Toggle
            checked={draft.status.disk}
            onChange={(v) => onChange("status.disk", v)}
          />
        </Row>
      </Section>

      <ResetButton
        keys={["status.net", "status.metrics", "status.disk"]}
        onReset={onReset}
      />
    </>
  );
}

/**
 * 更新检查区块。
 *
 * 检查结果放在全局 store（lib/update.ts）里，而不是组件 state：
 * 关掉设置弹层再打开，上次的检查结果仍然在；检查中重复点击也只发一个请求。
 * 点击立即发起请求，与设置草稿模型无关，也不受「保存」影响。
 */
function UpdateSection({
  onShowUpdate,
}: {
  onShowUpdate?: (info: UpdateInfo) => void;
}) {
  const state = useUpdateState();
  const [version, setVersion] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .appInfo()
      .then((info) => {
        if (alive) setVersion(info.version);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const checking = state.phase === "checking";
  const info = state.info;
  const failure = state.failure;
  const checkedAt = state.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "";

  return (
    <Section title="版本更新">
      <Row label="当前版本">
        <span className="mono update-version-now">{version || "读取中…"}</span>
      </Row>

      {state.phase === "idle" && (
        <div className="settings-note">
          启动约 30 秒后会自动静默检查一次；也可以现在手动检查。
          发现新版本只会先提示，下载和重启都需要你确认。
        </div>
      )}

      {checking && <div className="update-state checking">正在检查更新…</div>}

      {state.phase === "uptodate" && (
        <div className="update-state ok">
          已是最新版本{version ? ` v${version}` : ""}
          {checkedAt ? ` · 检查于 ${checkedAt}` : ""}
        </div>
      )}

      {state.phase === "available" && info && (
        <div className="update-state found">
          <div className="update-headline">发现新版本 v{info.version}</div>
          <div className="update-meta">
            当前 v{info.currentVersion}
            {info.date ? ` · 发布于 ${info.date}` : ""}
            {` · 安装包 ${formatBytes(info.size)}`}
          </div>
          {info.notes && <div className="update-notes">{info.notes}</div>}
          <button
            type="button"
            className="btn primary"
            onClick={() => onShowUpdate?.(info)}
          >
            下载并安装
          </button>
        </div>
      )}

      {state.phase === "error" && failure && (
        <div className="update-state error">
          <div className="update-headline">{failure.title}</div>
          <div className="update-meta">{failure.detail}</div>
          <div className="update-advice">{failure.advice}</div>
          {checkedAt && <div className="update-meta">检查于 {checkedAt}</div>}
        </div>
      )}

      <div className="settings-page-footer">
        <button
          type="button"
          className="btn"
          disabled={checking}
          onClick={() => {
            void requestUpdateCheck();
          }}
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
      </div>
    </Section>
  );
}

function DiagnosticsPage({
  draft,
  onChange,
  onReset,
  updateEnabled,
  onShowUpdate,
}: PageProps) {
  const [known, setKnown] = useState<KnownHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadKnownHosts = () => {
    api
      .listKnownHosts()
      .then((list) => setKnown(list))
      .catch((e) => {
        setKnown([]);
        setError(errorMessage(e));
      });
  };

  useEffect(() => {
    loadKnownHosts();
  }, []);

  const removeKnownHost = async (id: number) => {
    try {
      await api.deleteKnownHost(id);
      setError(null);
      loadKnownHosts();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <Section title="窗口行为">
        <Row
          label="关闭窗口时最小化到托盘"
          desc="SSH 会话保留在后台。托盘单击可恢复窗口；右键托盘或按 Ctrl+Q 可真正退出"
        >
          <Toggle
            checked={draft.behavior.closeToTray}
            onChange={(v) => onChange("behavior.closeToTray", v)}
          />
        </Row>
      </Section>

      {updateEnabled && <UpdateSection onShowUpdate={onShowUpdate} />}

      <Section title="命令历史">
        <Row
          label="记录命令历史"
          desc="关闭后新命令不再写入历史，已有记录保留"
        >
          <Toggle
            checked={draft.history.enabled}
            onChange={(v) => onChange("history.enabled", v)}
          />
        </Row>
      </Section>

      <Section title="已知主机">
        <div className="settings-note">
          首次连接确认过的主机指纹。删除后下次连接会重新询问是否信任。
        </div>
        {known === null ? (
          <div className="settings-placeholder">正在读取…</div>
        ) : known.length === 0 ? (
          <div className="settings-placeholder">暂无已信任的主机</div>
        ) : (
          <div className="settings-known">
            <div className="settings-known-row head">
              <span>主机</span>
              <span>算法</span>
              <span>指纹</span>
              <span />
            </div>
            {known.map((item) => (
              <div className="settings-known-row" key={item.id}>
                <span className="mono" title={item.host}>
                  {item.host}:{item.port}
                </span>
                <span>{item.algo}</span>
                <span className="mono fp" title={item.fingerprint}>
                  {item.fingerprint}
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => removeKnownHost(item.id)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <div className="settings-desc">{error}</div>}
        <div className="settings-page-footer">
          <button type="button" className="btn" onClick={loadKnownHosts}>
            刷新列表
          </button>
        </div>
      </Section>

      <ResetButton
        keys={[
          "history.enabled",
          "status.net",
          "status.metrics",
          "status.disk",
          "behavior.closeToTray",
        ]}
        onReset={onReset}
      />
    </>
  );
}

// ---------- 弹层 ----------

/**
 * 设置弹层。
 *
 * 采用草稿 + 保存模型：
 * - 弹层内的所有修改只写入本地 draft，点「保存」才一次性落库并应用；
 * - 点「关闭」/ Esc / 点遮罩时，如果有改动会先确认，确认后直接丢弃草稿；
 * - 「恢复本页默认」也只是把 draft 改回默认值，保存时才删除数据库键。
 */
export default function SettingsDialog({
  onClose,
  updateEnabled,
  onShowUpdate,
}: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();
  const [page, setPage] = useState<PageId>("appearance");
  const [baseline] = useState(() => cloneSettings(getSettings()));
  const [draft, setDraft] = useState(() => cloneSettings(getSettings()));
  const [resetKeys, setResetKeys] = useState<Set<SettingsKey>>(new Set());
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 本次弹层内新复制、但还没保存的背景图，关闭时要清理 */
  const pendingCopies = useRef<Set<string>>(new Set());

  const dirty = !settingsEqual(draft, baseline) || resetKeys.size > 0;

  const cleanupCopies = (keep: string) => {
    for (const path of pendingCopies.current) {
      if (path && path !== keep) {
        api.deleteTerminalBackground(path).catch(() => {});
      }
    }
    pendingCopies.current.clear();
  };

  /** 丢弃草稿并关闭：不写数据库，不应用任何修改 */
  const discardAndClose = () => {
    cleanupCopies("");
    onClose();
  };

  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      discardAndClose();
      return;
    }
    setConfirmClose(true);
  };

  useShortcuts([
    {
      combo: "escape",
      description: "关闭设置",
      handler: () => {
        if (confirmClose) setConfirmClose(false);
        else requestClose();
      },
    },
  ]);

  const onChange = (key: SettingsKey, value: string | number | boolean) => {
    setDraft((prev) => withSetting(prev, key, value));
    setResetKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const onReset = (keys: SettingsKey[]) => {
    setDraft((prev) => {
      let next = prev;
      for (const key of keys) next = withSetting(next, key, getDefaultSetting(key));
      return next;
    });
    setResetKeys((prev) => new Set([...prev, ...keys]));
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = draft;
      const changed = await commitSettings(saved, [...resetKeys]);

      // 清理未被采用的副本，以及被替换掉/清除掉的旧背景图
      cleanupCopies(saved.terminal.backgroundImage);
      if (
        saved.terminal.backgroundImage !== baseline.terminal.backgroundImage &&
        baseline.terminal.backgroundImage
      ) {
        api
          .deleteTerminalBackground(baseline.terminal.backgroundImage)
          .catch(() => {});
      }

      const connectionKeys: SettingsKey[] = [
        "connection.timeoutSec",
        "connection.defaultPort",
      ];
      if (changed.length === 0 && resetKeys.size === 0) {
        notify.info("没有需要保存的修改");
      } else if (
        changed.length > 0 &&
        changed.every((key) => connectionKeys.includes(key))
      ) {
        notify.success("已保存；当前会话不变，新建连接时生效");
      } else if (changed.length === 0) {
        notify.success("已恢复默认并保存");
      } else if (changed.some((key) => connectionKeys.includes(key))) {
        notify.success(
          "已保存并立即应用；建连超时 / 默认端口将在新建连接时生效"
        );
      } else {
        notify.success("已保存并立即应用");
      }
      onClose();
    } catch (e) {
      setSaving(false);
      notify.error(errorMessage(e));
    }
  };

  const pageProps: PageProps = {
    draft,
    onChange,
    onReset,
    updateEnabled,
    onShowUpdate,
  };

  const renderPage = () => {
    switch (page) {
      case "appearance":
        return (
          <AppearancePage
            {...pageProps}
            onNewCopy={(path) => pendingCopies.current.add(path)}
          />
        );
      case "terminal":
        return <TerminalPage {...pageProps} />;
      case "connection":
        return <ConnectionPage {...pageProps} />;
      case "transfer":
        return <TransferPage {...pageProps} />;
      case "statusbar":
        return <StatusBarPage {...pageProps} />;
      case "diagnostics":
        return <DiagnosticsPage {...pageProps} />;
    }
  };

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
      onKeyDown={(e) => {
        // 全局快捷键在输入框里不生效，这里补上 Esc，输入数字时也能直接关闭
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (confirmClose) setConfirmClose(false);
        else requestClose();
      }}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-label="设置"
        className="dialog settings-dialog"
      >
        <header>
          <Icon name="settings" size={15} />
          设置
          <div className="spacer" />
          <span className={`settings-dirty ${dirty ? "on" : ""}`}>
            {dirty ? "有未保存的修改" : ""}
          </span>
          <button
            type="button"
            className="icon-btn"
            title="关闭"
            onClick={requestClose}
          >
            <Icon name="close" size={11} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === page ? "on" : ""}
                onClick={() => setPage(p.id)}
              >
                {p.title}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            <div className="settings-page">{renderPage()}</div>
          </div>
        </div>

        <footer>
          <button type="button" className="btn outline" onClick={requestClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>

        {confirmClose && (
          <div className="settings-confirm">
            <div className="settings-confirm-box">
              <div className="settings-confirm-title">有未保存的修改</div>
              <div className="settings-confirm-text">
                关闭将丢弃本次所有修改，且不会写入数据库。
              </div>
              <div className="settings-confirm-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={discardAndClose}
                >
                  放弃修改
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setConfirmClose(false)}
                >
                  继续编辑
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
