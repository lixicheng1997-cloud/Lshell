//! 命令历史脱敏
//!
//! 命令历史是明文保存在本地数据库里的。很多命令会把口令写在参数里
//! （`mysql --password=xxx`、`export TOKEN=xxx`、带 userinfo 的 URL 等），
//! 直接落库等于把凭据写进磁盘。这里在**写入前**把常见位置的值替换成
//! `***`，历史里只保留命令结构。
//!
//! 只做保守识别：命中已知敏感关键字才替换，宁可漏掉也不误伤普通命令。

/// 值本身敏感的长参数（`--flag value` 与 `--flag=value` 两种写法）
const SECRET_FLAGS: &[&str] = &[
    "--password",
    "--passwd",
    "--pass",
    "--token",
    "--secret",
    "--api-key",
    "--apikey",
    "--access-key",
    "--secret-key",
    "--credential",
    "--credentials",
];

/// 键名里包含这些词时，`key=value` 的 value 视为敏感
const SECRET_KEY_HINTS: &[&str] = &[
    "password",
    "passwd",
    "pass",
    "token",
    "secret",
    "apikey",
    "api_key",
    "access_key",
    "accesskey",
    "credential",
];

fn is_secret_flag(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    SECRET_FLAGS
        .iter()
        .any(|f| lower == *f || lower.starts_with(&format!("{f}=")))
}

fn secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_KEY_HINTS.iter().any(|h| lower.contains(h))
}

/// 把 URL userinfo 里的密码替换掉：`scheme://user:pass@host` → `scheme://user:***@host`
fn redact_url_userinfo(token: &str) -> String {
    let Some(scheme_end) = token.find("://") else {
        return token.to_string();
    };
    let rest = &token[scheme_end + 3..];
    let Some(at) = rest.rfind('@') else {
        return token.to_string();
    };
    let userinfo = &rest[..at];
    let Some(colon) = userinfo.find(':') else {
        return token.to_string();
    };
    let user = &userinfo[..colon];
    let tail = &rest[at..];
    let scheme = &token[..scheme_end];
    format!("{scheme}://{user}:***{tail}")
}

/// 对一条命令做脱敏，返回可以直接落库的文本
pub fn command(cmd: &str) -> String {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    let mut out: Vec<String> = Vec::with_capacity(tokens.len());
    let mut mask_next = false;

    for token in tokens {
        let lower = token.to_ascii_lowercase();

        if mask_next {
            // `Authorization: Bearer xxx` 中 Bearer/Basic 是关键字，真正要遮的是下一段
            let keep = lower == "bearer" || lower == "basic";
            out.push(if keep {
                token.to_string()
            } else {
                "***".into()
            });
            mask_next = keep;
            continue;
        }

        // `--password=xxx`
        if let Some((flag, _)) = token.split_once('=') {
            if is_secret_flag(flag) {
                out.push(format!("{flag}=***"));
                continue;
            }
        }

        // `--password xxx`：只吃紧跟在后面的一个 token
        if is_secret_flag(token) {
            out.push(token.to_string());
            mask_next = true;
            continue;
        }

        // `KEY=value`（环境变量、查询串）
        if let Some((key, value)) = token.split_once('=') {
            if secret_key(key) && !value.is_empty() {
                // 保留值末尾的引号，避免把命令结构改坏
                let quote = if value.ends_with('"') || value.ends_with('\'') {
                    &value[value.len() - 1..]
                } else {
                    ""
                };
                out.push(format!("{key}=***{quote}"));
                continue;
            }
        }

        // `Authorization: Bearer xxx` 的两种常见断词结果
        if lower == "bearer" || lower == "basic" {
            out.push(token.to_string());
            mask_next = true;
            continue;
        }
        if lower.ends_with("authorization:") || lower.ends_with("authorization") {
            out.push(token.to_string());
            mask_next = true;
            continue;
        }

        // `-u user:pass` 与 `--user user:pass`
        if token == "-u" || lower == "--user" {
            out.push(token.to_string());
            mask_next = true;
            continue;
        }

        let redacted = redact_url_userinfo(token);
        out.push(redacted);
    }

    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_long_flag_forms() {
        assert_eq!(
            command("mysql --password=hunter2 -h db"),
            "mysql --password=*** -h db"
        );
        assert_eq!(
            command("redis-cli --pass secret123 get k"),
            "redis-cli --pass *** get k"
        );
    }

    #[test]
    fn masks_env_assignments_and_query() {
        assert_eq!(
            command("export GITHUB_TOKEN=abc123"),
            "export GITHUB_TOKEN=***"
        );
        assert_eq!(
            command("curl 'https://api.example.com?access_key=xyz'"),
            "curl 'https://api.example.com?access_key=***'"
        );
    }

    #[test]
    fn masks_url_userinfo() {
        assert_eq!(
            command("git clone https://alice:pa55@example.com/repo.git"),
            "git clone https://alice:***@example.com/repo.git"
        );
    }

    #[test]
    fn masks_authorization_header() {
        assert_eq!(
            command("curl -H Authorization: Bearer abcdefg"),
            "curl -H Authorization: Bearer ***"
        );
    }

    #[test]
    fn leaves_normal_commands_untouched() {
        assert_eq!(command("ls -la /var/log"), "ls -la /var/log");
        assert_eq!(command("ssh -p 2222 root@host"), "ssh -p 2222 root@host");
        assert_eq!(command("find . -name '*.rs'"), "find . -name '*.rs'");
    }
}
