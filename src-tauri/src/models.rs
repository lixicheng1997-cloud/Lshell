//! 数据模型：与前端共享的序列化结构

use serde::{Deserialize, Serialize};

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
    /// 首次见到，需要用户确认指纹
    Unknown { fingerprint: String, algo: String },
    /// 指纹与记录不符，必须阻断
    Mismatch {
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

/// 搜索语法：`tag:prod` 精确匹配标签，其余为别名/地址/用户名模糊匹配
#[derive(Debug, Clone, Default)]
pub struct HostQuery {
    pub text: Option<String>,
    pub tag_id: Option<i64>,
}
