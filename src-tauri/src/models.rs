//! 数据模型：与前端共享的序列化结构

use serde::{Deserialize, Serialize};

/// 应用元信息（关于对话框与标题栏版本号展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: i64,
    pub alias: String,
    pub address: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    pub group_id: Option<i64>,
    pub note: String,
    pub key_path: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub tags: Vec<Tag>,
    /// 代理类型：none / http / socks5
    pub proxy_type: String,
    pub proxy_host: String,
    pub proxy_port: i64,
    pub proxy_username: String,
    /// 单跳跳板机（引用另一台主机）
    pub jump_host_id: Option<i64>,
    /// 终端类型，空表示用默认 xterm-256color
    pub term: String,
    /// 远端输出编码：utf-8 / gbk / big5
    pub encoding: String,
    /// 登录后自动执行的命令
    pub startup_command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i64,
}

/// 新建/更新主机的输入
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub alias: String,
    pub address: String,
    #[serde(default = "default_port")]
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    pub group_id: Option<i64>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub key_path: Option<String>,
    /// 明文密码，保存时加密入库；为 None 表示不改动已有密码
    #[serde(default)]
    pub password: Option<String>,
    /// 私钥口令
    #[serde(default)]
    pub key_passphrase: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    /// 代理类型：none / http / socks5；缺省按 none 处理
    #[serde(default)]
    pub proxy_type: Option<String>,
    #[serde(default)]
    pub proxy_host: Option<String>,
    #[serde(default)]
    pub proxy_port: Option<i64>,
    #[serde(default)]
    pub proxy_username: Option<String>,
    /// 代理密码明文，保存时加密入库；None 表示不改动已有密码
    #[serde(default)]
    pub proxy_password: Option<String>,
    #[serde(default)]
    pub jump_host_id: Option<i64>,
    #[serde(default)]
    pub term: Option<String>,
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub startup_command: Option<String>,
}

fn default_port() -> i64 {
    22
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub id: i64,
    pub host_id: i64,
    pub local_port: i64,
    pub remote_host: String,
    pub remote_port: i64,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub id: i64,
    pub host: String,
    pub port: i64,
    pub algo: String,
    pub fingerprint: String,
    pub added_at: i64,
}

/// 主机密钥校验结果，供前端决定是否弹确认框
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum HostKeyCheck {
    /// 已记录且指纹一致
    Trusted,
    /// 首次见到（该算法），需要用户确认指纹
    Unknown {
        fingerprint: String,
        algo: String,
        /// 该主机已记录过其它算法的密钥 —— 说明是新增密钥类型而非首次连接
        known_other_algo: bool,
    },
    /// 同一算法下指纹与记录不符：阻断连接，可经用户「确认更新」后替换
    Mismatch {
        algo: String,
        stored_fingerprint: String,
        presented_fingerprint: String,
    },
}

/// 连接结果。
///
/// 首次连接某台主机时不会直接失败，而是返回 `NeedsHostKeyTrust`，
/// 由前端展示指纹让用户确认后再写入 known_hosts 并重连。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConnectOutcome {
    /// 连接成功，会话已建立
    Connected,
    /// 首次见到该主机，等待用户确认指纹
    NeedsHostKeyTrust {
        fingerprint: String,
        algo: String,
    },
    /// 指纹与既有记录不符，等待用户确认更新
    HostKeyChanged {
        fingerprint: String,
        algo: String,
        stored_fingerprint: String,
    },
}

/// 一条命令历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    pub id: i64,
    pub host_id: i64,
    pub command: String,
    /// 执行命令时所在的远端目录
    pub cwd: String,
    pub created_at: i64,
}

/// 远程文件编辑的审计记录（不含内容与密码）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAudit {
    pub id: i64,
    pub host_id: i64,
    pub remote_path: String,
    pub elevated_mode: String,
    pub forced: bool,
    pub result: String,
    pub bytes: i64,
    pub created_at: i64,
}

/// 导入预检里的一条提示（跳过的指令、无效行等）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarning {
    /// 源文件里的行号（JSON 时为条目序号）
    pub line: usize,
    pub message: String,
}

/// 待导入的一台主机（还未落库）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub alias: String,
    pub address: String,
    pub port: i64,
    pub username: String,
    pub key_path: Option<String>,
    /// ssh config 的 ProxyJump 值（别名或 user@host:port），落库时尽量解析成跳板机
    pub jump: Option<String>,
    pub note: String,
}

/// 导入预检结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub path: String,
    /// sshConfig / json
    pub format: String,
    pub candidates: Vec<ImportCandidate>,
    pub warnings: Vec<ImportWarning>,
    /// 主机库里已存在（同地址+端口+用户名）而会被跳过的数量
    pub duplicates: usize,
}

/// 导入执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: usize,
    pub skipped: usize,
}

/// 常用命令片段（全局，不绑定主机）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: i64,
    /// 展示名，可为空（界面回退显示命令本身）
    pub name: String,
    pub command: String,
    pub sort_order: i64,
    pub created_at: i64,
}

/// 搜索语法：`tag:prod` 精确匹配标签，其余为别名/地址/用户名模糊匹配
#[derive(Debug, Clone, Default)]
pub struct HostQuery {
    pub text: Option<String>,
    pub tag_id: Option<i64>,
}
