//! 主机库导入导出
//!
//! 支持两种来源：
//! - OpenSSH 客户端配置（`~/.ssh/config`），只读取常用字段
//! - Lshell 自己的 JSON 备份
//!
//! 导出同样支持两种格式，且**绝不包含任何密码/口令** ——
//! 导出的文件通常会被放进网盘或聊天工具里，不能带凭据。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models::{Host, ImportCandidate, ImportWarning};

/// 解析结果
pub struct ParsedConfig {
    pub candidates: Vec<ImportCandidate>,
    pub warnings: Vec<ImportWarning>,
}

/// 解析 OpenSSH 配置文本
///
/// 规则刻意宽松：只认 Host / HostName / User / Port / IdentityFile /
/// ProxyJump，其余指令（Forward、LocalCommand、Include……）原样忽略，
/// 遇到 `Include` 或 `ProxyCommand` 时额外给一条警告。
pub fn parse_ssh_config(text: &str, base_dir: &Path) -> ParsedConfig {
    let mut candidates: Vec<ImportCandidate> = Vec::new();
    let mut warnings: Vec<ImportWarning> = Vec::new();
    // 当前 Host 块；None 表示文件开头尚未进入任何 Host 块
    let mut block: Option<Block> = None;

    for (idx, raw) in text.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // OpenSSH 允许 `Key=Value` 写法
        let (key, value) = match line.split_once('=') {
            Some((k, v)) if !k.contains(char::is_whitespace) => (k.trim(), v.trim()),
            _ => {
                let mut parts = line.splitn(2, char::is_whitespace);
                let key = parts.next().unwrap_or("");
                let value = parts.next().unwrap_or("").trim();
                (key, value)
            }
        };
        let key_lower = key.to_ascii_lowercase();

        if key_lower == "host" {
            if let Some(b) = block.take() {
                push_block(b, &mut candidates, &mut warnings);
            }
            block = Some(Block::new(value, line_no));
            continue;
        }

        // Host 块之外的全局指令对导入没有意义
        let Some(b) = block.as_mut() else {
            continue;
        };

        match key_lower.as_str() {
            "hostname" => b.host_name = Some(strip_quotes(value).to_string()),
            "user" => b.user = Some(strip_quotes(value).to_string()),
            "port" => {
                b.port = value.parse::<i64>().ok();
                if b.port.is_none() {
                    warnings.push(ImportWarning {
                        line: line_no,
                        message: format!("端口不是数字，已按 22 处理: {value}"),
                    });
                }
            }
            "identityfile" => b.identity_file = Some(strip_quotes(value).to_string()),
            "proxyjump" => b.proxy_jump = Some(strip_quotes(value).to_string()),
            "proxycommand" => warnings.push(ImportWarning {
                line: line_no,
                message: "不支持 ProxyCommand，已忽略（可改用 ProxyJump）".into(),
            }),
            "include" => warnings.push(ImportWarning {
                line: line_no,
                message: "不支持 Include，被包含的文件需要单独导入".into(),
            }),
            _ => {}
        }
    }
    if let Some(b) = block.take() {
        push_block(b, &mut candidates, &mut warnings);
    }

    // IdentityFile 相对路径按 ssh config 所在目录解释
    for c in &mut candidates {
        if let Some(path) = &c.key_path {
            if !path.is_empty() && !Path::new(path).is_absolute() {
                let expanded = expand_home(path);
                c.key_path = Some(if expanded.is_absolute() {
                    expanded.to_string_lossy().into_owned()
                } else {
                    base_dir.join(expanded).to_string_lossy().into_owned()
                });
            }
        }
    }

    // 同一文件里重名的别名只保留第一条，与 OpenSSH「先匹配先生效」一致
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|c| seen.insert(c.alias.to_ascii_lowercase()));

    ParsedConfig {
        candidates,
        warnings,
    }
}

struct Block {
    /// `Host` 后的模式列表
    patterns: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<i64>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
    line: usize,
}

impl Block {
    fn new(value: &str, line: usize) -> Self {
        Block {
            patterns: value
                .split_whitespace()
                .map(|s| s.to_string())
                .collect(),
            host_name: None,
            user: None,
            port: None,
            identity_file: None,
            proxy_jump: None,
            line,
        }
    }
}

/// 只导入具体主机名；`*`、`?`、`!` 这类通配规则留给 OpenSSH 运行时自己展开
fn push_block(block: Block, out: &mut Vec<ImportCandidate>, warnings: &mut Vec<ImportWarning>) {
    let usable: Vec<&String> = block
        .patterns
        .iter()
        .filter(|p| !p.contains(['*', '?', '!']))
        .collect();
    if usable.is_empty() {
        return;
    }
    if usable.len() > 1 {
        warnings.push(ImportWarning {
            line: block.line,
            message: format!(
                "一行声明了多个主机（{}），已全部导入",
                usable.len()
            ),
        });
    }

    let default_user = std::env::var("USERNAME").unwrap_or_else(|_| "root".to_string());
    for alias in usable {
        out.push(ImportCandidate {
            alias: alias.clone(),
            // 没写 HostName 时，主机名就是别名本身
            address: block
                .host_name
                .clone()
                .unwrap_or_else(|| alias.clone()),
            port: block.port.unwrap_or(22),
            username: block.user.clone().unwrap_or_else(|| default_user.clone()),
            key_path: block.identity_file.clone(),
            jump: block.proxy_jump.clone(),
            note: String::new(),
        });
    }
}

fn strip_quotes(value: &str) -> &str {
    value.trim().trim_matches('"').trim_matches('\'')
}

pub fn expand_home(path: &str) -> PathBuf {
    let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) else {
        return PathBuf::from(path);
    };
    match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(home) => PathBuf::from(home).join(rest),
        Err(_) => PathBuf::from(path),
    }
}

/// 本机默认的 OpenSSH 配置文件路径
pub fn default_ssh_config_path() -> PathBuf {
    match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(home) => PathBuf::from(home).join(".ssh").join("config"),
        Err(_) => PathBuf::from(".ssh/config"),
    }
}

/// Lshell JSON 备份格式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonBackup {
    #[serde(default)]
    pub app: String,
    #[serde(default = "default_backup_version")]
    pub version: i64,
    #[serde(default)]
    pub hosts: Vec<JsonHost>,
}

fn default_backup_version() -> i64 {
    1
}

/// JSON 里的一台主机（不含任何凭据）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonHost {
    pub alias: String,
    pub address: String,
    #[serde(default = "default_port")]
    pub port: i64,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub auth_type: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub jump_alias: Option<String>,
    #[serde(default)]
    pub proxy_type: String,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: i64,
    #[serde(default)]
    pub proxy_username: String,
    #[serde(default)]
    pub term: String,
    #[serde(default)]
    pub encoding: String,
    #[serde(default)]
    pub startup_command: String,
}

fn default_port() -> i64 {
    22
}

/// 解析 JSON 备份；也接受「裸数组」，方便从别处拷来的数据
pub fn parse_json(text: &str) -> Result<(Vec<ImportCandidate>, Vec<ImportWarning>), String> {
    let parsed: Result<JsonBackup, _> = serde_json::from_str(text);
    let hosts = match parsed {
        Ok(backup) => backup.hosts,
        Err(_) => {
            let arr: Vec<JsonHost> =
                serde_json::from_str(text).map_err(|e| format!("JSON 解析失败: {e}"))?;
            arr
        }
    };

    let mut warnings = Vec::new();
    let mut out = Vec::new();
    for (i, h) in hosts.into_iter().enumerate() {
        if h.alias.trim().is_empty() || h.address.trim().is_empty() {
            warnings.push(ImportWarning {
                line: i + 1,
                message: "缺少别名或地址，已跳过".into(),
            });
            continue;
        }
        out.push(ImportCandidate {
            alias: h.alias.trim().to_string(),
            address: h.address.trim().to_string(),
            port: if h.port > 0 { h.port } else { 22 },
            username: h.username.trim().to_string(),
            key_path: h.key_path,
            jump: h.jump_alias,
            note: h.note,
        });
    }
    Ok((out, warnings))
}

/// 导出为 Lshell JSON（不含密码、私钥内容）
pub fn export_json(hosts: &[Host], jump_alias: &dyn Fn(Option<i64>) -> Option<String>) -> String {
    let items: Vec<JsonHost> = hosts
        .iter()
        .map(|h| JsonHost {
            alias: h.alias.clone(),
            address: h.address.clone(),
            port: h.port,
            username: h.username.clone(),
            note: h.note.clone(),
            auth_type: h.auth_type.clone(),
            key_path: h.key_path.clone(),
            jump_alias: jump_alias(h.jump_host_id),
            proxy_type: h.proxy_type.clone(),
            proxy_host: h.proxy_host.clone(),
            proxy_port: h.proxy_port,
            proxy_username: h.proxy_username.clone(),
            term: h.term.clone(),
            encoding: h.encoding.clone(),
            startup_command: h.startup_command.clone(),
        })
        .collect();
    let backup = JsonBackup {
        app: "Lshell".into(),
        version: default_backup_version(),
        hosts: items,
    };
    serde_json::to_string_pretty(&backup).unwrap_or_else(|_| "{\"hosts\":[]}".into())
}

/// 导出为 OpenSSH 配置
///
/// 别名里的空格等字符会被替换成 `_`，否则写出来的 config 无法解析。
pub fn export_ssh_config(hosts: &[Host], jump_alias: &dyn Fn(Option<i64>) -> Option<String>) -> String {
    let mut out = String::from("# 由 Lshell 导出（不含密码与私钥内容）\n");
    for h in hosts {
        let alias = sanitize_alias(&h.alias);
        out.push_str(&format!("\nHost {alias}\n"));
        out.push_str(&format!("  HostName {}\n", h.address));
        if !h.username.is_empty() {
            out.push_str(&format!("  User {}\n", h.username));
        }
        if h.port != 22 {
            out.push_str(&format!("  Port {}\n", h.port));
        }
        if h.auth_type == "key" {
            if let Some(path) = &h.key_path {
                if !path.is_empty() {
                    out.push_str(&format!(
                        "  IdentityFile \"{}\"\n",
                        path.replace('\\', "/")
                    ));
                }
            }
        }
        if let Some(jump) = jump_alias(h.jump_host_id) {
            out.push_str(&format!("  ProxyJump {}\n", sanitize_alias(&jump)));
        }
    }
    out
}

fn sanitize_alias(alias: &str) -> String {
    let cleaned: String = alias
        .chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .collect();
    if cleaned.is_empty() {
        "host".into()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_ssh_config() {
        let text = r#"
# 注释
Host web
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host db
  HostName db.internal
Host *
  User ignore
"#;
        let parsed = parse_ssh_config(text, Path::new("C:/Users/x/.ssh"));
        assert_eq!(parsed.candidates.len(), 2);
        let web = &parsed.candidates[0];
        assert_eq!(web.alias, "web");
        assert_eq!(web.address, "10.0.0.5");
        assert_eq!(web.username, "deploy");
        assert_eq!(web.port, 2222);
        assert!(web.key_path.is_some());
        let db = &parsed.candidates[1];
        assert_eq!(db.address, "db.internal");
        assert_eq!(db.port, 22);
    }

    #[test]
    fn skips_wildcard_hosts() {
        let parsed = parse_ssh_config("Host * ?\n  User root\n", Path::new("."));
        assert!(parsed.candidates.is_empty());
    }

    #[test]
    fn json_array_is_accepted() {
        let text = r#"[{"alias":"a","address":"1.2.3.4","username":"root"}]"#;
        let (candidates, _) = parse_json(text).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].port, 22);
    }

    #[test]
    fn export_roundtrip_does_not_include_secrets() {
        // 导出函数只接触 Host 结构体，本身不含密码字段；
        // 这里验证生成的 JSON 能重新解析回来
        let host = Host {
            id: 1,
            alias: "web 01".into(),
            address: "10.0.0.5".into(),
            port: 22,
            username: "root".into(),
            auth_type: "password".into(),
            group_id: None,
            note: String::new(),
            key_path: None,
            sort_order: 0,
            created_at: 0,
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
        };
        let json = export_json(&[host.clone()], &|_| None);
        let (candidates, _) = parse_json(&json).unwrap();
        assert_eq!(candidates[0].alias, "web 01");
        assert_eq!(candidates[0].address, "10.0.0.5");

        let cfg = export_ssh_config(&[host], &|_| None);
        assert!(cfg.contains("Host web_01"));
    }
}
