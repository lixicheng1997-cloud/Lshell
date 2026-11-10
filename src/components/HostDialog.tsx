import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { useDialogFocus } from "../lib/dialog";
import { getSettings } from "../lib/settings";
import type { Group, Host, HostInput, Tag } from "../lib/types";
import Icon from "./Icon";

interface Props {
  host: Host | null;
  groups: Group[];
  tags: Tag[];
  /** 全部主机，用于跳板机下拉（会排除当前主机自身） */
  hosts: Host[];
  /** 新建时预选的分组（从分组行的「+」进入时传入） */
  defaultGroupId?: number | null;
  onClose: () => void;
  onSaved: (id: number, alias: string) => void;
}

const EMPTY: HostInput = {
  alias: "",
  address: "",
  port: 22,
  username: "",
  authType: "password",
  groupId: null,
  note: "",
  keyPath: null,
  password: null,
  keyPassphrase: null,
  tagIds: [],
  proxyType: "none",
  proxyHost: "",
  proxyPort: null,
  proxyUsername: "",
  proxyPassword: null,
  jumpHostId: null,
  term: "",
  encoding: "utf-8",
  startupCommand: "",
};

/** 新建标签时轮换取色，保证同一批新标签颜色可区分 */
const NEW_TAG_COLORS = [
  "#7C8CFF",
  "#35D6A4",
  "#F0B429",
  "#46B8E0",
  "#F2555A",
  "#D2A8FF",
];

/**
 * 新建 / 编辑主机对话框。
 */
export default function HostDialog({
  host,
  groups,
  tags,
  hosts,
  defaultGroupId = null,
  onClose,
  onSaved,
}: Props) {
  const { ref, dialogProps } = useDialogFocus<HTMLDivElement>();
  const [form, setForm] = useState<HostInput>(EMPTY);
  const [tagName, setTagName] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTags, setNewTags] = useState<Tag[]>([]);
  const tagSelectRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (host) {
      setForm({
        alias: host.alias,
        address: host.address,
        port: host.port,
        username: host.username,
        authType: host.authType,
        groupId: host.groupId,
        note: host.note,
        keyPath: host.keyPath,
        password: null,
        keyPassphrase: null,
        tagIds: host.tags.map((t) => t.id),
        proxyType: host.proxyType,
        proxyHost: host.proxyHost,
        proxyPort: host.proxyPort || null,
        proxyUsername: host.proxyUsername,
        proxyPassword: null,
        jumpHostId: host.jumpHostId,
        term: host.term,
        encoding: host.encoding || "utf-8",
        startupCommand: host.startupCommand,
      });
    } else {
      setForm({
        ...EMPTY,
        port: getSettings().connection.defaultPort,
        groupId: defaultGroupId,
      });
    }
    setError(null);
    setTagName("");
    setTagOpen(false);
    setNewTags([]);
  }, [host, defaultGroupId]);

  const set = <K extends keyof HostInput>(key: K, value: HostInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * 下拉选项：来自已有标签集合（App 传入的 tags）、本次新建的临时标签，
   * 以及当前主机已关联的标签（防止列表刷新滞后时已选标签不在选项中）。
   * 按名称去重后按名称排序，保证每次打开顺序一致。
   */
  const allTags = useMemo(() => {
    const seen = new Set<string>();
    const merged: Tag[] = [];
    for (const t of [...tags, ...newTags, ...(host?.tags ?? [])]) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      merged.push(t);
    }
    return merged.sort(
      (a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id - b.id
    );
  }, [tags, newTags, host]);

  /** 跳板机候选：排除当前主机自身，避免自引用 */
  const jumpCandidates = useMemo(
    () => hosts.filter((h) => h.id !== host?.id),
    [hosts, host]
  );

  /** 已选标签（用于触发器上的展示） */
  const selectedTags = allTags.filter((t) => form.tagIds.includes(t.id));

  // 下拉展开时：点击外部或按 Esc 收起
  useEffect(() => {
    if (!tagOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!tagSelectRef.current?.contains(e.target as Node)) setTagOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tagOpen]);

  const submit = async () => {
    setError(null);
    if (!form.alias.trim()) return setError("别名不能为空");
    if (!form.address.trim()) return setError("地址不能为空");
    if (!form.username.trim()) return setError("用户名不能为空");
    if (form.authType === "key" && !form.keyPath) {
      return setError("私钥认证必须选择私钥文件");
    }

    setBusy(true);
    try {
      // 新建标签先落库拿到真实 id：form.tagIds 里存的是占位负数 id，
      // 必须就地替换，否则会把占位 id 当作外键写进 host_tags
      const idByTemp = new Map<number, number>();
      for (const t of newTags) {
        if (!form.tagIds.includes(t.id)) continue; // 建完又取消选中的不落库
        const saved = await api.upsertTag(t.name, t.color);
        idByTemp.set(t.id, saved.id);
      }
      const tagIds = form.tagIds.map((id) => idByTemp.get(id) ?? id);
      const id = await api.saveHost({ ...form, tagIds }, host?.id);
      onSaved(id, form.alias.trim());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pickKeyFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "私钥文件", extensions: ["pem", "key", "ppk"] }],
      });
      if (typeof selected === "string") {
        set("keyPath", selected);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const toggleTag = (id: number) => {
    set(
      "tagIds",
      form.tagIds.includes(id)
        ? form.tagIds.filter((t) => t !== id)
        : [...form.tagIds, id]
    );
  };

  const addTag = () => {
    const name = tagName.trim();
    if (!name) return;
    const existing = allTags.find((t) => t.name === name);
    if (existing) {
      toggleTag(existing.id);
    } else {
      const t: Tag = {
        id: -Date.now() - newTags.length,
        name,
        color: NEW_TAG_COLORS[newTags.length % NEW_TAG_COLORS.length],
      };
      setNewTags((prev) => [...prev, t]);
      set("tagIds", [...form.tagIds, t.id]);
    }
    setTagName("");
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-label={host ? "编辑主机" : "新建主机"}
        className="dialog"
        style={{ width: 520 }}
      >
        <header>
          <Icon name={host ? "settings" : "plus"} size={15} />
          {host ? "编辑主机" : "新建主机"}
        </header>

        <div className="body">
          {error && (
            <div className="banner error">
              <Icon name="alert-circle" />
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label>别名</label>
            <input
              value={form.alias}
              onChange={(e) => set("alias", e.target.value)}
              placeholder="web-01"
              autoFocus
            />
          </div>

          <div className="field">
            <label>地址</label>
            <input
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              placeholder="10.0.0.5 或 example.com"
            />
          </div>

          <div className="field">
            <label>端口</label>
            <input
              type="number"
              value={form.port}
              onChange={(e) =>
                set("port", Number(e.target.value) || getSettings().connection.defaultPort)
              }
            />
          </div>

          <div className="field">
            <label>用户名</label>
            <input
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="root"
            />
          </div>

          <div className="field">
            <label>认证方式</label>
            <select
              value={form.authType}
              onChange={(e) =>
                set("authType", e.target.value as HostInput["authType"])
              }
            >
              <option value="password">密码</option>
              <option value="key">私钥</option>
              <option value="agent">SSH Agent</option>
            </select>
          </div>

          {form.authType === "agent" && (
            <div className="banner info">
              <Icon name="info" />
              <span>
                使用 Windows OpenSSH Agent 或 Pageant 中已加载的密钥，无需填写密码或私钥
              </span>
            </div>
          )}

          {form.authType === "password" && (
            <div className="field">
              <label>密码</label>
              <input
                type="password"
                value={form.password ?? ""}
                onChange={(e) => set("password", e.target.value)}
                placeholder={
                  host ? "留空表示不修改已保存的密码" : "将加密保存在本机"
                }
              />
            </div>
          )}

          {form.authType === "key" && (
            <>
              <div className="field">
                <label>私钥文件</label>
                <div className="row">
                  <input
                    value={form.keyPath ?? ""}
                    onChange={(e) => set("keyPath", e.target.value)}
                    placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                    readOnly
                  />
                  <button className="btn outline" onClick={pickKeyFile}>
                    浏览
                  </button>
                </div>
              </div>
              <div className="field">
                <label>密钥口令</label>
                <input
                  type="password"
                  value={form.keyPassphrase ?? ""}
                  onChange={(e) => set("keyPassphrase", e.target.value)}
                  placeholder={host ? "留空表示不修改" : "留空表示私钥未加密"}
                />
              </div>
            </>
          )}

          <div className="field">
            <label>分组</label>
            <select
              value={form.groupId ?? ""}
              onChange={(e) =>
                set("groupId", e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">无分组（根层）</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>TERM</label>
            <input
              value={form.term ?? ""}
              onChange={(e) => set("term", e.target.value)}
              placeholder="留空使用 xterm-256color"
            />
          </div>

          <div className="field">
            <label>远端字符集</label>
            <select
              value={form.encoding ?? "utf-8"}
              onChange={(e) => set("encoding", e.target.value)}
            >
              <option value="utf-8">UTF-8</option>
              <option value="gbk">GBK（简体中文）</option>
              <option value="big5">Big5（繁体中文）</option>
            </select>
          </div>

          <div className="field">
            <label>启动命令</label>
            <input
              value={form.startupCommand ?? ""}
              onChange={(e) => set("startupCommand", e.target.value)}
              placeholder="登录后自动执行，例如 cd /var/log"
            />
          </div>

          <div className="field">
            <label>跳板机</label>
            <select
              value={form.jumpHostId ?? ""}
              onChange={(e) =>
                set(
                  "jumpHostId",
                  e.target.value ? Number(e.target.value) : null
                )
              }
            >
              <option value="">不使用跳板</option>
              {jumpCandidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.alias}（{h.address}）
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>出站代理</label>
            <select
              value={form.proxyType ?? "none"}
              onChange={(e) =>
                set(
                  "proxyType",
                  e.target.value as HostInput["proxyType"]
                )
              }
            >
              <option value="none">不使用代理</option>
              <option value="http">HTTP CONNECT</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>

          {(form.proxyType ?? "none") !== "none" && (
            <>
              <div className="field">
                <label>代理地址</label>
                <input
                  value={form.proxyHost ?? ""}
                  onChange={(e) => set("proxyHost", e.target.value)}
                  placeholder="127.0.0.1"
                />
              </div>
              <div className="field">
                <label>代理端口</label>
                <input
                  type="number"
                  value={form.proxyPort ?? ""}
                  onChange={(e) =>
                    set(
                      "proxyPort",
                      e.target.value ? Number(e.target.value) : null
                    )
                  }
                  placeholder="8080"
                />
              </div>
              <div className="field">
                <label>代理用户名</label>
                <input
                  value={form.proxyUsername ?? ""}
                  onChange={(e) => set("proxyUsername", e.target.value)}
                  placeholder="可选"
                />
              </div>
              <div className="field">
                <label>代理密码</label>
                <input
                  type="password"
                  value={form.proxyPassword ?? ""}
                  onChange={(e) => set("proxyPassword", e.target.value)}
                  placeholder={host ? "留空表示不修改" : "可选，将加密保存"}
                />
              </div>
            </>
          )}

          <div className="field top">
            <label>标签</label>
            <div className="tag-select" ref={tagSelectRef}>
              <button
                type="button"
                className={`tag-select-trigger ${tagOpen ? "open" : ""}`}
                onClick={() => setTagOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={tagOpen}
              >
                <span className="tag-select-value">
                  {selectedTags.length === 0 ? (
                    <span className="tag-select-placeholder">选择标签</span>
                  ) : (
                    selectedTags.map((t) => (
                      <span key={t.id} className="tag-pill">
                        <span className="dot" style={{ background: t.color }} />
                        {t.name}
                      </span>
                    ))
                  )}
                </span>
                <Icon name="chevron-down" size={12} className="tag-select-chev" />
              </button>

              {tagOpen && (
                <div
                  className="tag-select-panel"
                  role="listbox"
                  aria-multiselectable="true"
                >
                  {allTags.length === 0 && (
                    <div className="tag-select-empty">
                      还没有标签，可在下方输入名称新建
                    </div>
                  )}
                  {allTags.map((t) => {
                    const on = form.tagIds.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={`tag-option ${on ? "on" : ""}`}
                        onClick={() => toggleTag(t.id)}
                      >
                        <span className="check">
                          {on && <Icon name="check" size={12} />}
                        </span>
                        <span className="dot" style={{ background: t.color }} />
                        <span className="name">{t.name}</span>
                      </button>
                    );
                  })}
                  {/* 原先标签是自由输入，保留了下拉内的新建入口 */}
                  <div className="tag-select-new">
                    <input
                      value={tagName}
                      placeholder="新建标签"
                      onChange={(e) => setTagName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTag();
                        }
                      }}
                    />
                    <button
                      className="btn outline"
                      onClick={addTag}
                      disabled={!tagName.trim()}
                    >
                      添加
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="field top">
            <label>备注</label>
            <textarea
              rows={2}
              value={form.note}
              onChange={(e) => set("note", e.target.value)}
              placeholder="用途说明、环境信息等"
            />
          </div>
        </div>

        <footer>
          <button className="btn outline" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}
