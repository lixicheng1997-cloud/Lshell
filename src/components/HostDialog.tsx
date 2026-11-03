import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { Group, Host, HostInput, Tag } from "../lib/types";
import Icon from "./Icon";

interface Props {
  host: Host | null;
  groups: Group[];
  tags: Tag[];
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
  defaultGroupId = null,
  onClose,
  onSaved,
}: Props) {
  const [form, setForm] = useState<HostInput>(EMPTY);
  const [tagName, setTagName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTags, setNewTags] = useState<Tag[]>([]);

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
      });
    } else {
      setForm({ ...EMPTY, groupId: defaultGroupId });
    }
    setError(null);
    setTagName("");
    setNewTags([]);
  }, [host, defaultGroupId]);

  const set = <K extends keyof HostInput>(key: K, value: HostInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const allTags = [...tags, ...newTags];

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
      // 先把新建标签落库，拿到 id 后再关联主机
      const created: Tag[] = [];
      for (const t of newTags) {
        created.push(await api.upsertTag(t.name, t.color));
      }
      const tagIds = [...form.tagIds, ...created.map((t) => t.id)];
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
      <div className="dialog" style={{ width: 520 }}>
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
              onChange={(e) => set("port", Number(e.target.value) || 22)}
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
            </select>
          </div>

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
              <option value="">未分组</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field top">
            <label>标签</label>
            <div className="row tags-line">
              <div className="tags-scroll">
                {allTags.map((t) => {
                  const on = form.tagIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      className={`tag-chip ${on ? "on" : ""}`}
                      onClick={() => toggleTag(t.id)}
                      style={on ? { color: t.color } : undefined}
                    >
                      <span className="dot" style={{ background: t.color }} />
                      {t.name}
                    </button>
                  );
                })}
              </div>
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
