//! SQLite 存储层
//!
//! 单文件数据库，位于 `%APPDATA%/Lshell/lshell.db`。

use rusqlite::{params, Connection};

use crate::error::{AppError, Result};
use crate::models::{
    CommandRecord, EditorAudit, Forward, Group, Host, HostQuery, KnownHost, Snippet, Tag,
};

/// schema 版本号，写入 `PRAGMA user_version`
///
/// - 0：旧版 —— 主密码 + Argon2id 派生密钥
/// - 1：主密钥由系统密钥保护层（Windows DPAPI）保管
/// - 2：新增命令历史表
/// - 3：主机增加代理/跳板与终端 profile 列；新增命令片段表
const SCHEMA_VERSION: i64 = 3;

/// 单台主机保留的命令历史条数上限
///
/// 命令历史是辅助功能，不是审计日志 —— 保留最近的几百条足够回溯，
/// 又不至于让数据库无限膨胀。
const COMMAND_HISTORY_LIMIT: i64 = 500;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#378ADD'
);

CREATE TABLE IF NOT EXISTS hosts (
  id            INTEGER PRIMARY KEY,
  alias         TEXT NOT NULL,
  address       TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 22,
  username      TEXT NOT NULL,
  auth_type     TEXT NOT NULL CHECK (auth_type IN ('password','key','agent')),
  group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  password_id   INTEGER REFERENCES vault_secrets(id),
  key_id        INTEGER REFERENCES vault_secrets(id),
  key_path      TEXT,
  key_pass_id   INTEGER REFERENCES vault_secrets(id),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  proxy_type    TEXT NOT NULL DEFAULT 'none',
  proxy_host    TEXT NOT NULL DEFAULT '',
  proxy_port    INTEGER NOT NULL DEFAULT 0,
  proxy_username TEXT NOT NULL DEFAULT '',
  proxy_password_id INTEGER REFERENCES vault_secrets(id),
  jump_host_id  INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
  term          TEXT NOT NULL DEFAULT '',
  encoding      TEXT NOT NULL DEFAULT 'utf-8',
  startup_command TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS host_tags (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (host_id, tag_id)
);

CREATE TABLE IF NOT EXISTS vault_secrets (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('password','key','passphrase')),
  ciphertext  BLOB NOT NULL,
  nonce       BLOB NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- 主密钥由系统密钥保护层（Windows DPAPI）加密后落盘。
-- protector 记录保护方式，便于将来扩展或迁移。
CREATE TABLE IF NOT EXISTS vault_key (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  protector   TEXT NOT NULL,
  wrapped_key BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forwards (
  id          INTEGER PRIMARY KEY,
  host_id     INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  local_port  INTEGER NOT NULL,
  remote_host TEXT NOT NULL,
  remote_port INTEGER NOT NULL,
  auto_start  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host_id, local_port)
);

CREATE TABLE IF NOT EXISTS known_hosts (
  id          INTEGER PRIMARY KEY,
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  algo        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  UNIQUE (host, port, algo)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 命令历史：用户在终端里执行过的命令，按主机归档。
-- 不存密码输入等敏感内容，只记录命令文本本身。
CREATE TABLE IF NOT EXISTS command_history (
  id         INTEGER PRIMARY KEY,
  host_id    INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  command    TEXT NOT NULL,
  cwd        TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- 远程文件编辑审计：只记录路径、提权方式与结果，绝不记录文件内容或密码
CREATE TABLE IF NOT EXISTS editor_audit (
  id            INTEGER PRIMARY KEY,
  host_id       INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  remote_path   TEXT NOT NULL,
  elevated_mode TEXT NOT NULL,
  forced        INTEGER NOT NULL DEFAULT 0,
  result        TEXT NOT NULL,
  bytes         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_editor_audit_host ON editor_audit(host_id, created_at DESC);

-- 常用命令片段：全局共享，不绑定主机
CREATE TABLE IF NOT EXISTS snippets (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  command    TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosts_alias   ON hosts(alias);
CREATE INDEX IF NOT EXISTS idx_hosts_address ON hosts(address);
CREATE INDEX IF NOT EXISTS idx_hosts_group   ON hosts(group_id);
CREATE INDEX IF NOT EXISTS idx_hosts_last_used ON hosts(last_used_at);
CREATE INDEX IF NOT EXISTS idx_host_tags_tag ON host_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_known_hosts   ON known_hosts(host, port);
CREATE INDEX IF NOT EXISTS idx_cmd_hist_host ON command_history(host_id, id DESC);
"#;

/// hosts 表的列顺序，与 [`host_from_row`] 的索引一一对应。
///
/// 集中成常量，避免列表查询与单条查询各自维护一份列清单后出现错位。
const HOST_COLUMNS: &str = "id, alias, address, port, username, auth_type, group_id, note, \
     key_path, sort_order, created_at, last_used_at, proxy_type, proxy_host, proxy_port, \
     proxy_username, jump_host_id, term, encoding, startup_command";

fn host_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Host> {
    Ok(Host {
        id: row.get(0)?,
        alias: row.get(1)?,
        address: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        auth_type: row.get(5)?,
        group_id: row.get(6)?,
        note: row.get(7)?,
        key_path: row.get(8)?,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        last_used_at: row.get(11)?,
        tags: Vec::new(),
        proxy_type: row.get(12)?,
        proxy_host: row.get(13)?,
        proxy_port: row.get(14)?,
        proxy_username: row.get(15)?,
        jump_host_id: row.get(16)?,
        term: row.get(17)?,
        encoding: row.get(18)?,
        startup_command: row.get(19)?,
    })
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Internal(format!("创建数据目录失败: {e}")))?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    /// 按 `PRAGMA user_version` 逐级执行 schema 迁移
    ///
    /// 每个版本一个独立的 `if` 块，**不要**合并成一个
    /// `if version < SCHEMA_VERSION { ... }` ——
    /// 那会让 v1 库在升级到 v2 时重跑 v0→v1 的清理逻辑，
    /// 把已经加密好的凭据清空。
    ///
    /// - v0 → v1：主密码方案下线。
    ///   旧凭据用「主密码经 Argon2id 派生」的密钥加密。主密码功能移除后，
    ///   那把密钥再也无法重建，旧密文成为不可解的死数据 —— 与其留着，
    ///   不如直接清空并让用户重新录入一次。
    ///   主机档案本身（地址、用户名、分组、标签、备注）全部保留，
    ///   只有 `password_id` / `key_id` / `key_pass_id` 三个引用被置空。
    /// - v1 → v2：新增命令历史表。
    ///   表结构由 `SCHEMA` 里的 `CREATE TABLE IF NOT EXISTS` 建好，
    ///   这里只需把版本号推进。
    /// - v2 → v3：主机增加代理/跳板与终端 profile 列；新增命令片段表。
    ///
    ///   SQLite 的 `ALTER TABLE ADD COLUMN` 不能重复执行，而新建库的
    ///   `CREATE TABLE` 已经带上了这些列，因此逐列检查后再加 ——
    ///   新旧库走同一条路径，不会出现「新库升级时列已存在」的错误。
    fn migrate(&self) -> Result<()> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if version < 1 {
            // 先清引用再删密文：hosts.password_id 外键指向 vault_secrets(id)
            self.conn.execute(
                "UPDATE hosts SET password_id = NULL, key_id = NULL, key_pass_id = NULL",
                [],
            )?;
            self.conn.execute("DELETE FROM vault_secrets", [])?;
            self.conn.execute("DROP TABLE IF EXISTS vault_meta", [])?;
        }

        if version < 2 {
            // command_history 表已在 SCHEMA 中建好，无需额外 DDL
        }

        if version < 3 {
            // snippets 表已在 SCHEMA 中建好，这里只补 hosts 的新列。
            // 都是「有默认值的非空列」或「可空列」，旧行自动取默认值，
            // 已存的主机与凭据不受影响。
            const COLUMNS: &[(&str, &str)] = &[
                ("proxy_type", "proxy_type TEXT NOT NULL DEFAULT 'none'"),
                ("proxy_host", "proxy_host TEXT NOT NULL DEFAULT ''"),
                ("proxy_port", "proxy_port INTEGER NOT NULL DEFAULT 0"),
                ("proxy_username", "proxy_username TEXT NOT NULL DEFAULT ''"),
                (
                    "proxy_password_id",
                    "proxy_password_id INTEGER REFERENCES vault_secrets(id)",
                ),
                ("jump_host_id", "jump_host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL"),
                ("term", "term TEXT NOT NULL DEFAULT ''"),
                ("encoding", "encoding TEXT NOT NULL DEFAULT 'utf-8'"),
                ("startup_command", "startup_command TEXT NOT NULL DEFAULT ''"),
            ];
            for (name, ddl) in COLUMNS {
                self.add_column_if_missing("hosts", name, ddl)?;
            }
        }

        if version != SCHEMA_VERSION {
            self.conn
                .pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }

        Ok(())
    }

    /// 列不存在时才执行 `ALTER TABLE ... ADD COLUMN`
    fn add_column_if_missing(&self, table: &str, column: &str, ddl: &str) -> Result<()> {
        let mut stmt = self.conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let exists = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == column);
        if !exists {
            self.conn
                .execute(&format!("ALTER TABLE {table} ADD COLUMN {ddl}"), [])?;
        }
        Ok(())
    }

    // ---------- 主机 ----------

    pub fn list_hosts(&self, query: &HostQuery) -> Result<Vec<Host>> {
        let mut sql = format!("SELECT {} FROM hosts", HOST_COLUMNS);
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(tag_id) = query.tag_id {
            sql.push_str(" JOIN host_tags ht ON ht.host_id = hosts.id WHERE ht.tag_id = ?1");
            args.push(Box::new(tag_id));
        }

        if let Some(text) = &query.text {
            let text = text.trim();
            if !text.is_empty() {
                let clause = if query.tag_id.is_some() { " AND" } else { " WHERE" };
                sql.push_str(&format!(
                    "{clause} (hosts.alias LIKE ?{} OR hosts.address LIKE ?{} OR hosts.username LIKE ?{})",
                    args.len() + 1,
                    args.len() + 1,
                    args.len() + 1
                ));
                let pattern = format!("%{text}%");
                args.push(Box::new(pattern));
            }
        }

        sql.push_str(" ORDER BY sort_order ASC, alias ASC");

        let mut stmt = self.conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(params_ref.as_slice(), host_from_row)?;

        let mut hosts: Vec<Host> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for host in &mut hosts {
            host.tags = self.tags_for_host(host.id)?;
        }
        Ok(hosts)
    }

    /// 最近连接的主机（按 `last_used_at` 倒序），供侧栏「最近连接」使用
    pub fn list_recent_hosts(&self, limit: i64) -> Result<Vec<Host>> {
        let sql = format!(
            "SELECT {HOST_COLUMNS} FROM hosts WHERE last_used_at IS NOT NULL \
             ORDER BY last_used_at DESC LIMIT ?1"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit], host_from_row)?;
        let mut hosts: Vec<Host> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for host in &mut hosts {
            host.tags = self.tags_for_host(host.id)?;
        }
        Ok(hosts)
    }

    pub fn get_host(&self, id: i64) -> Result<Option<Host>> {
        self.host_by_id_raw(id)
    }

    fn host_by_id_raw(&self, id: i64) -> Result<Option<Host>> {
        let sql = format!("SELECT {HOST_COLUMNS} FROM hosts WHERE id = ?1");
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            let mut host = host_from_row(row)?;
            host.tags = self.tags_for_host(host.id)?;
            Ok(Some(host))
        } else {
            Ok(None)
        }
    }

    /// 插入新主机。
    ///
    /// 四个凭据引用由调用方给出：常规保存只写 password_id / key_pass_id
    /// （以及代理密码 proxy_password_id），复制主机时连同 key_id 一起
    /// 沿用原主机的引用（不落明文、不新建密文）。
    pub fn insert_host(
        &self,
        host: &Host,
        password_id: Option<i64>,
        key_id: Option<i64>,
        key_pass_id: Option<i64>,
        proxy_password_id: Option<i64>,
    ) -> Result<i64> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO hosts (alias, address, port, username, auth_type, group_id, note, \
             password_id, key_id, key_path, key_pass_id, sort_order, created_at, \
             proxy_type, proxy_host, proxy_port, proxy_username, proxy_password_id, \
             jump_host_id, term, encoding, startup_command) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
            params![
                host.alias,
                host.address,
                host.port,
                host.username,
                host.auth_type,
                host.group_id,
                host.note,
                password_id,
                key_id,
                host.key_path,
                key_pass_id,
                host.sort_order,
                host.created_at,
                host.proxy_type,
                host.proxy_host,
                host.proxy_port,
                host.proxy_username,
                proxy_password_id,
                host.jump_host_id,
                host.term,
                host.encoding,
                host.startup_command,
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }

    pub fn update_host(
        &self,
        id: i64,
        host: &Host,
        password_id: Option<i64>,
        key_pass_id: Option<i64>,
        proxy_password_id: Option<i64>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE hosts SET alias=?2, address=?3, port=?4, username=?5, auth_type=?6, \
             group_id=?7, note=?8, password_id=?9, key_path=?10, key_pass_id=?11, \
             proxy_type=?12, proxy_host=?13, proxy_port=?14, proxy_username=?15, \
             proxy_password_id=?16, jump_host_id=?17, term=?18, encoding=?19, startup_command=?20 \
             WHERE id=?1",
            params![
                id,
                host.alias,
                host.address,
                host.port,
                host.username,
                host.auth_type,
                host.group_id,
                host.note,
                password_id,
                host.key_path,
                key_pass_id,
                host.proxy_type,
                host.proxy_host,
                host.proxy_port,
                host.proxy_username,
                proxy_password_id,
                host.jump_host_id,
                host.term,
                host.encoding,
                host.startup_command,
            ],
        )?;
        Ok(())
    }

    pub fn delete_host(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn touch_host(&self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE hosts SET last_used_at = ?2 WHERE id = ?1",
            params![id, now_secs()],
        )?;
        Ok(())
    }

    // ---------- 标签 ----------

    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        let mut stmt = self.conn.prepare("SELECT id, name, color FROM tags ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn tags_for_host(&self, host_id: i64) -> Result<Vec<Tag>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.name, t.color FROM tags t \
             JOIN host_tags ht ON ht.tag_id = t.id WHERE ht.host_id = ?1 ORDER BY t.name ASC",
        )?;
        let rows = stmt.query_map(params![host_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn upsert_tag(&self, name: &str, color: &str) -> Result<Tag> {
        self.conn.execute(
            "INSERT INTO tags (name, color) VALUES (?1, ?2) \
             ON CONFLICT(name) DO UPDATE SET color = excluded.color",
            params![name, color],
        )?;
        let mut stmt = self.conn.prepare("SELECT id, name, color FROM tags WHERE name = ?1")?;
        let mut rows = stmt.query(params![name])?;
        let row = rows.next()?.ok_or_else(|| AppError::Internal("标签写入后未找到".into()))?;
        Ok(Tag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
        })
    }

    pub fn delete_tag(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_host_tags(&self, host_id: i64, tag_ids: &[i64]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM host_tags WHERE host_id = ?1", params![host_id])?;
        for tag_id in tag_ids {
            tx.execute(
                "INSERT OR IGNORE INTO host_tags (host_id, tag_id) VALUES (?1, ?2)",
                params![host_id, tag_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---------- 分组 ----------

    pub fn list_groups(&self) -> Result<Vec<Group>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, parent_id, sort_order FROM groups ORDER BY sort_order ASC, name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Group {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn insert_group(&self, name: &str, parent_id: Option<i64>) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO groups (name, parent_id) VALUES (?1, ?2)",
            params![name, parent_id],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn rename_group(&self, id: i64, name: &str) -> Result<()> {
        self.conn
            .execute("UPDATE groups SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    pub fn delete_group(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM groups WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 按给定顺序重写主机的分组归属与组内排序（拖拽用）
    pub fn reorder_hosts(&self, group_id: Option<i64>, ids: &[i64]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE hosts SET group_id = ?2, sort_order = ?3 WHERE id = ?1",
                params![id, group_id, i as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 按给定顺序重写分组排序（拖拽用）
    pub fn reorder_groups(&self, ids: &[i64]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE groups SET sort_order = ?2 WHERE id = ?1",
                params![id, i as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---------- 保险库 ----------

    /// 读取被系统密钥保护层包装的主密钥
    ///
    /// 返回 `(保护方式, 包装后的密钥)`；未初始化时返回 `None`。
    pub fn vault_key(&self) -> Result<Option<(String, Vec<u8>)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT protector, wrapped_key FROM vault_key WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get(0)?, row.get(1)?)))
        } else {
            Ok(None)
        }
    }

    /// 写入主密钥（已由保护层包装）
    pub fn init_vault(&self, protector: &str, wrapped_key: &[u8]) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO vault_key (id, protector, wrapped_key, created_at) \
             VALUES (1, ?1, ?2, ?3)",
            params![protector, wrapped_key, now_secs()],
        )?;
        Ok(())
    }

    pub fn insert_secret(&self, kind: &str, nonce: &[u8], ciphertext: &[u8], label: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO vault_secrets (kind, nonce, ciphertext, label, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![kind, nonce, ciphertext, label, now_secs()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_secret(&self, id: i64) -> Result<Option<(String, Vec<u8>, Vec<u8>)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT kind, nonce, ciphertext FROM vault_secrets WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?)))
        } else {
            Ok(None)
        }
    }

    /// 主机的四个凭据引用：(password_id, key_id, key_pass_id, proxy_password_id)
    pub fn secret_ids_for_host(
        &self,
        host_id: i64,
    ) -> Result<(Option<i64>, Option<i64>, Option<i64>, Option<i64>)> {
        let mut stmt = self.conn.prepare(
            "SELECT password_id, key_id, key_pass_id, proxy_password_id FROM hosts WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![host_id])?;
        if let Some(row) = rows.next()? {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        } else {
            Ok((None, None, None, None))
        }
    }

    // ---------- 已知主机 ----------

    // 注意：不要提供「只按 host+port 取一条」的查询。
    // 一台服务器可能同时持有多种算法的主机密钥，必须带 algo 一起匹配，
    // 否则会把「换了协商算法」误判成「密钥被替换」。
    // 相关查询见 list_known_hosts / insert_known_host / remove_known_host。

    pub fn insert_known_host(&self, host: &str, port: i64, algo: &str, fingerprint: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO known_hosts (host, port, algo, fingerprint, added_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![host, port, algo, fingerprint, now_secs()],
        )?;
        Ok(())
    }

    pub fn delete_known_host(&self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM known_hosts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_known_hosts(&self) -> Result<Vec<KnownHost>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, host, port, algo, fingerprint, added_at FROM known_hosts \
             ORDER BY host ASC, port ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(KnownHost {
                id: row.get(0)?,
                host: row.get(1)?,
                port: row.get(2)?,
                algo: row.get(3)?,
                fingerprint: row.get(4)?,
                added_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---------- 端口转发 ----------

    pub fn list_forwards(&self, host_id: i64) -> Result<Vec<Forward>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, host_id, local_port, remote_host, remote_port, auto_start FROM forwards \
             WHERE host_id = ?1 ORDER BY local_port ASC",
        )?;
        let rows = stmt.query_map(params![host_id], |row| {
            Ok(Forward {
                id: row.get(0)?,
                host_id: row.get(1)?,
                local_port: row.get(2)?,
                remote_host: row.get(3)?,
                remote_port: row.get(4)?,
                auto_start: row.get::<_, i64>(5)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn upsert_forward(&self, host_id: i64, f: &Forward) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO forwards (host_id, local_port, remote_host, remote_port, auto_start) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(host_id, local_port) DO UPDATE SET \
             remote_host = excluded.remote_host, remote_port = excluded.remote_port, \
             auto_start = excluded.auto_start",
            params![host_id, f.local_port, f.remote_host, f.remote_port, f.auto_start as i64],
        )?;
        let mut stmt = self.conn.prepare(
            "SELECT id FROM forwards WHERE host_id = ?1 AND local_port = ?2",
        )?;
        let id: i64 = stmt.query_row(params![host_id, f.local_port], |row| row.get(0))?;
        Ok(id)
    }

    pub fn delete_forward(&self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM forwards WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 命令历史 ----------

    /// 记录一条命令。
    ///
    /// 连续重复的同一命令只更新时间戳，不新增行 ——
    /// 与 bash 的 `HISTCONTROL=ignoredups` 行为一致，
    /// 否则连按几下回车就会把历史刷满。
    pub fn insert_command(&self, host_id: i64, command: &str, cwd: &str) -> Result<i64> {
        let command = command.trim();
        if command.is_empty() {
            return Ok(0);
        }

        // 上一条是否就是同一条命令
        let previous: Option<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT command FROM command_history WHERE host_id = ?1 ORDER BY id DESC LIMIT 1",
            )?;
            let mut rows = stmt.query(params![host_id])?;
            match rows.next()? {
                Some(row) => Some(row.get(0)?),
                None => None,
            }
        };

        if previous.as_deref() == Some(command) {
            self.conn.execute(
                "UPDATE command_history SET created_at = ?1 WHERE id = \
                 (SELECT id FROM command_history WHERE host_id = ?2 ORDER BY id DESC LIMIT 1)",
                params![now_secs(), host_id],
            )?;
            let mut stmt = self.conn.prepare(
                "SELECT id FROM command_history WHERE host_id = ?1 ORDER BY id DESC LIMIT 1",
            )?;
            let id: i64 = stmt.query_row(params![host_id], |row| row.get(0))?;
            return Ok(id);
        }

        self.conn.execute(
            "INSERT INTO command_history (host_id, command, cwd, created_at) \
             VALUES (?1,?2,?3,?4)",
            params![host_id, command, cwd, now_secs()],
        )?;
        let id = self.conn.last_insert_rowid();

        // 裁剪：每台主机只保留最近 N 条
        self.conn.execute(
            "DELETE FROM command_history WHERE host_id = ?1 AND id NOT IN (\
             SELECT id FROM command_history WHERE host_id = ?1 ORDER BY id DESC LIMIT ?2)",
            params![host_id, COMMAND_HISTORY_LIMIT],
        )?;

        Ok(id)
    }

    /// 列出命令历史。
    ///
    /// `host_id` 为 `None` 时返回全部主机的历史（跨主机搜索）。
    /// 结果按 id 倒序，即最近执行的在前。
    /// 记录一条远程编辑审计。不写入文件内容、密码或命令行。
    pub fn insert_editor_audit(
        &self,
        host_id: i64,
        remote_path: &str,
        elevated_mode: &str,
        forced: bool,
        result: &str,
        bytes: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO editor_audit
             (host_id, remote_path, elevated_mode, forced, result, bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                host_id,
                remote_path,
                elevated_mode,
                forced as i32,
                result,
                bytes,
                now_secs()
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// 查询编辑审计；host_id 为 None 表示跨全部主机。
    pub fn list_editor_audit(&self, host_id: Option<i64>, limit: i64) -> Result<Vec<EditorAudit>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, host_id, remote_path, elevated_mode, forced, result, bytes, created_at
             FROM editor_audit
             WHERE ?1 IS NULL OR host_id = ?1
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![host_id, limit.clamp(1, 200)], |row| {
            Ok(EditorAudit {
                id: row.get(0)?,
                host_id: row.get(1)?,
                remote_path: row.get(2)?,
                elevated_mode: row.get(3)?,
                forced: row.get::<_, i32>(4)? != 0,
                result: row.get(5)?,
                bytes: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_commands(
        &self,
        host_id: Option<i64>,
        query: Option<&str>,
        limit: i64,
    ) -> Result<Vec<CommandRecord>> {
        let mut sql = String::from(
            "SELECT id, host_id, command, cwd, created_at FROM command_history",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut clauses: Vec<String> = Vec::new();

        if let Some(id) = host_id {
            clauses.push(format!("host_id = ?{}", args.len() + 1));
            args.push(Box::new(id));
        }
        if let Some(text) = query {
            let text = text.trim();
            if !text.is_empty() {
                clauses.push(format!("command LIKE ?{}", args.len() + 1));
                args.push(Box::new(format!("%{text}%")));
            }
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY id DESC LIMIT ?");
        args.push(Box::new(limit));

        let mut stmt = self.conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(params_ref.as_slice(), |row| {
            Ok(CommandRecord {
                id: row.get(0)?,
                host_id: row.get(1)?,
                command: row.get(2)?,
                cwd: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 清空命令历史；`host_id` 为 `None` 时清空全部
    pub fn clear_commands(&self, host_id: Option<i64>) -> Result<usize> {
        let affected = match host_id {
            Some(id) => self
                .conn
                .execute("DELETE FROM command_history WHERE host_id = ?1", params![id])?,
            None => self.conn.execute("DELETE FROM command_history", [])?,
        };
        Ok(affected)
    }

    /// 只更新跳板机引用（导入时做第二遍解析用，避免重写整行）
    pub fn set_host_jump(&self, host_id: i64, jump_host_id: Option<i64>) -> Result<()> {
        self.conn.execute(
            "UPDATE hosts SET jump_host_id = ?2 WHERE id = ?1",
            params![host_id, jump_host_id],
        )?;
        Ok(())
    }

    // ---------- 常用命令片段 ----------

    pub fn list_snippets(&self) -> Result<Vec<Snippet>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, command, sort_order, created_at FROM snippets \
             ORDER BY sort_order ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Snippet {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 新增或更新片段；`id` 为 None 时新建。
    pub fn upsert_snippet(&self, id: Option<i64>, name: &str, command: &str) -> Result<i64> {
        match id {
            Some(existing) => {
                self.conn.execute(
                    "UPDATE snippets SET name = ?2, command = ?3 WHERE id = ?1",
                    params![existing, name, command],
                )?;
                Ok(existing)
            }
            None => {
                let next: i64 = self
                    .conn
                    .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM snippets", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0);
                self.conn.execute(
                    "INSERT INTO snippets (name, command, sort_order, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![name, command, next, now_secs()],
                )?;
                Ok(self.conn.last_insert_rowid())
            }
        }
    }

    pub fn delete_snippet(&self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 设置 ----------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// 读取全部设置，供前端启动时一次性加载
    pub fn list_settings(&self) -> Result<std::collections::HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (key, value) = row?;
            out.insert(key, value);
        }
        Ok(out)
    }

    /// 删除某项设置（恢复默认时使用）
    pub fn delete_setting(&self, key: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用主机骨架：新列取默认值，各用例只覆盖自己关心的字段
    fn blank_host(alias: &str, address: &str) -> Host {
        Host {
            id: 0,
            alias: alias.into(),
            address: address.into(),
            port: 22,
            username: "root".into(),
            auth_type: "password".into(),
            group_id: None,
            note: String::new(),
            key_path: None,
            sort_order: 0,
            created_at: now_secs(),
            last_used_at: None,
            tags: vec![],
            proxy_type: "none".into(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_username: String::new(),
            jump_host_id: None,
            term: String::new(),
            encoding: "utf-8".into(),
            startup_command: String::new(),
        }
    }

    #[test]
    fn host_crud_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let host = blank_host("web-01", "10.0.0.5");
        let id = db.insert_host(&host, None, None, None, None).unwrap();
        let fetched = db.get_host(id).unwrap().unwrap();
        assert_eq!(fetched.alias, "web-01");
        assert_eq!(fetched.address, "10.0.0.5");
    }

    #[test]
    fn host_profile_and_proxy_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let mut host = blank_host("legacy", "10.0.0.6");
        host.proxy_type = "socks5".into();
        host.proxy_host = "127.0.0.1".into();
        host.proxy_port = 1080;
        host.encoding = "gbk".into();
        host.term = "xterm".into();
        host.startup_command = "cd /opt".into();
        let id = db.insert_host(&host, None, None, None, None).unwrap();
        let fetched = db.get_host(id).unwrap().unwrap();
        assert_eq!(fetched.proxy_type, "socks5");
        assert_eq!(fetched.proxy_port, 1080);
        assert_eq!(fetched.encoding, "gbk");
        assert_eq!(fetched.term, "xterm");
        assert_eq!(fetched.startup_command, "cd /opt");
    }

    #[test]
    fn recent_hosts_ordered_by_last_used() {
        let db = Db::open_in_memory().unwrap();
        let a = db.insert_host(&blank_host("a", "10.0.0.1"), None, None, None, None).unwrap();
        let b = db.insert_host(&blank_host("b", "10.0.0.2"), None, None, None, None).unwrap();
        // 时间戳精度是秒，直接写入固定值避免同一秒内顺序不确定
        db.conn
            .execute("UPDATE hosts SET last_used_at = 100 WHERE id = ?1", params![b])
            .unwrap();
        db.conn
            .execute("UPDATE hosts SET last_used_at = 200 WHERE id = ?1", params![a])
            .unwrap();
        let recent = db.list_recent_hosts(2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].alias, "a");
    }

    #[test]
    fn search_filters_by_text_and_tag() {
        let db = Db::open_in_memory().unwrap();
        let tag = db.upsert_tag("prod", "#378ADD").unwrap();
        for (alias, addr) in [("web-01", "10.0.0.1"), ("db-01", "10.0.0.2")] {
            let host = blank_host(alias, addr);
            db.insert_host(&host, None, None, None, None).unwrap();
        }
        let all = db.list_hosts(&HostQuery::default()).unwrap();
        assert_eq!(all.len(), 2);

        let filtered = db
            .list_hosts(&HostQuery {
                text: Some("web".into()),
                tag_id: None,
            })
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].alias, "web-01");

        let by_tag = db
            .list_hosts(&HostQuery {
                text: None,
                tag_id: Some(tag.id),
            })
            .unwrap();
        assert_eq!(by_tag.len(), 0);
    }

    #[test]
    fn vault_key_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.vault_key().unwrap().is_none());
        db.init_vault("dpapi", b"wrapped").unwrap();
        let (protector, wrapped) = db.vault_key().unwrap().unwrap();
        assert_eq!(protector, "dpapi");
        assert_eq!(wrapped, b"wrapped");
    }

    /// 建一台主机，返回其 id
    fn seed_host(db: &Db, alias: &str) -> i64 {
        db.insert_host(&blank_host(alias, "10.0.0.1"), None, None, None, None)
            .unwrap()
    }

    #[test]
    fn command_history_is_listed_newest_first() {
        let db = Db::open_in_memory().unwrap();
        let host_id = seed_host(&db, "web-01");
        db.insert_command(host_id, "ls -la", "/tmp").unwrap();
        db.insert_command(host_id, "ps aux", "/").unwrap();

        let list = db.list_commands(Some(host_id), None, 100).unwrap();
        assert_eq!(list.len(), 2);
        // 倒序：最近执行的在前
        assert_eq!(list[0].command, "ps aux");
        assert_eq!(list[1].command, "ls -la");
        assert_eq!(list[1].cwd, "/tmp");
    }

    #[test]
    fn command_history_ignores_consecutive_duplicates() {
        let db = Db::open_in_memory().unwrap();
        let host_id = seed_host(&db, "web-01");
        let first = db.insert_command(host_id, "uptime", "").unwrap();
        let second = db.insert_command(host_id, "uptime", "").unwrap();
        // 同一条命令不新增行，只更新时间戳
        assert_eq!(first, second);
        assert_eq!(db.list_commands(Some(host_id), None, 100).unwrap().len(), 1);

        // 中间插入别的命令后，再重复就是新的一条
        db.insert_command(host_id, "date", "").unwrap();
        db.insert_command(host_id, "uptime", "").unwrap();
        assert_eq!(db.list_commands(Some(host_id), None, 100).unwrap().len(), 3);
    }

    #[test]
    fn command_history_ignores_blank_commands() {
        let db = Db::open_in_memory().unwrap();
        let host_id = seed_host(&db, "web-01");
        assert_eq!(db.insert_command(host_id, "   ", "").unwrap(), 0);
        assert_eq!(db.insert_command(host_id, "", "").unwrap(), 0);
        assert!(db.list_commands(Some(host_id), None, 100).unwrap().is_empty());
    }

    #[test]
    fn command_history_filters_by_host_and_query() {
        let db = Db::open_in_memory().unwrap();
        let a = seed_host(&db, "web-01");
        let b = seed_host(&db, "db-01");
        db.insert_command(a, "tail -f app.log", "").unwrap();
        db.insert_command(b, "systemctl status nginx", "").unwrap();

        // 按主机过滤
        let only_a = db.list_commands(Some(a), None, 100).unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].command, "tail -f app.log");

        // 跨主机 + 关键字
        let grep = db.list_commands(None, Some("nginx"), 100).unwrap();
        assert_eq!(grep.len(), 1);
        assert_eq!(grep[0].host_id, b);

        // 跨主机全部
        assert_eq!(db.list_commands(None, None, 100).unwrap().len(), 2);
    }

    #[test]
    fn command_history_respects_limit() {
        let db = Db::open_in_memory().unwrap();
        let host_id = seed_host(&db, "web-01");
        for i in 0..10 {
            db.insert_command(host_id, &format!("cmd-{i}"), "").unwrap();
        }
        assert_eq!(db.list_commands(Some(host_id), None, 3).unwrap().len(), 3);
    }

    #[test]
    fn command_history_is_cleared_per_host() {
        let db = Db::open_in_memory().unwrap();
        let a = seed_host(&db, "web-01");
        let b = seed_host(&db, "db-01");
        db.insert_command(a, "ls", "").unwrap();
        db.insert_command(b, "pwd", "").unwrap();

        assert_eq!(db.clear_commands(Some(a)).unwrap(), 1);
        assert!(db.list_commands(Some(a), None, 100).unwrap().is_empty());
        // 另一台主机的历史不受影响
        assert_eq!(db.list_commands(Some(b), None, 100).unwrap().len(), 1);

        assert_eq!(db.clear_commands(None).unwrap(), 1);
        assert!(db.list_commands(None, None, 100).unwrap().is_empty());
    }

    #[test]
    fn command_history_is_dropped_with_host() {
        let db = Db::open_in_memory().unwrap();
        let host_id = seed_host(&db, "web-01");
        db.insert_command(host_id, "ls", "").unwrap();
        db.delete_host(host_id).unwrap();
        assert!(db.list_commands(None, None, 100).unwrap().is_empty());
    }

    #[test]
    fn migrating_from_v1_keeps_existing_secrets() {
        // 模拟一个 v1 库：有凭据引用，升级到 v2 后不能被清空
        let db = Db::open_in_memory().unwrap();
        db.conn.pragma_update(None, "user_version", 1).unwrap();

        // 造一条凭据记录
        db.insert_secret("password", b"nonce", b"cipher", "label").unwrap();
        let host_id = seed_host(&db, "web-01");
        db.conn
            .execute(
                "UPDATE hosts SET password_id = (SELECT id FROM vault_secrets LIMIT 1) WHERE id = ?1",
                params![host_id],
            )
            .unwrap();

        db.migrate().unwrap();

        // 版本号已推进
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // 凭据仍在
        let secrets: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM vault_secrets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(secrets, 1);
        assert!(db.secret_ids_for_host(host_id).unwrap().0.is_some());
    }
}
