//! 远程文本文件编辑：读取、可编辑判定、编码 / EOL / BOM、容量闸门与基线计算。
//!
//! 这里是读取侧与写入侧共用的纯逻辑层，不直接注册 Tauri 命令；
//! 命令层在 `commands.rs`，通过 `session::SharedSessions` 取得 SFTP 会话后调用本模块。
//!
//! 设计约束见 `docs/remote-editor-design.md` §4 / §6 / §7。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::ssh::{self, WaitResult};

/// 超过该值进入简化模式：前端关闭语法高亮与实时搜索，但仍可编辑。
pub const SOFT_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
/// 超过该值直接拒绝打开。
pub const HARD_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
/// 行数上限，与体积阈值独立生效，避免大文档渲染退化。
pub const MAX_LINES: usize = 200_000;
/// 二进制嗅探只检查开头这一段。
const SNIFF_LEN: usize = 8192;

/// 换行符类型。序列化为 `lf` / `crlf` / `mixed` / `none`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EolKind {
    Lf,
    Crlf,
    None,
}

/// 保存前比对的基线。SFTP 没有 ETag，mtime 又常为秒级精度，
/// 因此三者同时记录，任一不符即判定为冲突。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub size: u64,
    pub mtime: u64,
    pub sha256: String,
}

/// `editor_open` 的返回结构。
///
/// 内容用 base64 放在同一个 JSON 响应里：Tauri 的 `Response` 只有 body、
/// 没有响应头，无法像请求方向那样把元数据塞进 headers；两次调用读远端
/// 又会引入 TOCTOU。软上限 2 MiB 下 base64 的额外开销约 33%，可接受。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMeta {
    /// `canonicalize` 后的绝对路径
    pub path: String,
    pub encoding: String,
    pub eol: EolKind,
    pub bom: bool,
    /// 混用了 CRLF 与 LF（保存时按多数还原）
    pub mixed_eol: bool,
    pub language: String,
    pub read_only: bool,
    /// 当前用户对该文件没有写权限，保存时需要走 sudo 链路
    pub needs_elevation: bool,
    pub mode: u32,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub baseline: Baseline,
    pub soft_limit_mode: bool,
    pub content_base64: String,
    pub warning: Option<String>,
}

/// 内容嗅探结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentInfo {
    pub bom: bool,
    pub eol: EolKind,
    pub mixed_eol: bool,
    pub lines: usize,
    pub valid_utf8: bool,
    pub has_nul: bool,
}

fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(TABLE[(b >> 4) as usize] as char);
        out.push(TABLE[(b & 0x0f) as usize] as char);
    }
    out
}

/// 拒绝编辑的伪文件系统路径。POSIX 路径写法（Windows 客户端连 Linux 服务器）。
pub fn is_blocked_path(path: &str) -> bool {
    let normalized = path.trim_start_matches('/');
    let head = normalized.split('/').next().unwrap_or("");
    matches!(head, "proc" | "sys" | "dev")
}

/// 路径到语言的映射。全部在前端动态 import，未命中一律 plaintext。
pub fn detect_language(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);

    // 无扩展名或固定文件名特判
    match name {
        "dockerfile" => return "dockerfile",
        "makefile" | "gnumakefile" => return "makefile",
        "nginx.conf" => return "nginx",
        "sshd_config" | "ssh_config" => return "ssh_config",
        "hosts" | "fstab" | "sudoers" | "my.cnf" => return "properties",
        "crontab" => return "properties",
        ".env" => return "properties",
        ".gitignore" | ".gitattributes" => return "properties",
        ".bashrc" | ".bash_profile" | ".profile" | ".zshrc" => return "shell",
        _ => {}
    }
    // systemd unit
    if [".service", ".timer", ".socket", ".mount", ".target"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
    {
        return "ini";
    }
    // apt sources / yum repo
    if name.ends_with(".list") || name.ends_with(".repo") {
        return "properties";
    }

    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "vue" => "javascript",
        "py" | "pyi" => "python",
        "json" | "jsonc" => "json",
        "html" | "htm" | "xml" | "svg" => "html",
        "css" | "scss" | "less" => "css",
        "sql" => "sql",
        "rs" => "rust",
        "c" | "h" | "cc" | "cpp" | "hpp" | "hh" => "cpp",
        "java" => "java",
        "php" => "php",
        "go" => "go",
        "rb" => "ruby",
        "md" | "mdx" => "markdown",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "ini" | "cnf" => "ini",
        "sh" | "bash" | "zsh" | "ksh" => "shell",
        "conf" | "config" | "cfg" | "properties" => "properties",
        "txt" | "log" | "" => "plaintext",
        _ => "plaintext",
    }
}

/// 嗅探编码、BOM、换行与行数。不做转码：非 UTF-8 一律拒绝，
/// 避免「猜编码」把 GBK 配置写成乱码。
pub fn analyze_content(bytes: &[u8]) -> ContentInfo {
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let has_nul = bytes.iter().take(SNIFF_LEN).any(|&b| b == 0);
    let valid_utf8 = std::str::from_utf8(bytes).is_ok();

    let mut crlf = 0usize;
    let mut lone_lf = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            crlf += 1;
            i += 2;
            continue;
        }
        if bytes[i] == b'\n' {
            lone_lf += 1;
        }
        i += 1;
    }
    let mixed_eol = crlf > 0 && lone_lf > 0;
    let eol = if crlf == 0 && lone_lf == 0 {
        EolKind::None
    } else if lone_lf == 0 || crlf >= lone_lf {
        EolKind::Crlf
    } else {
        EolKind::Lf
    };

    let lines = bytes.iter().filter(|&&b| b == b'\n').count() + 1;
    ContentInfo {
        bom,
        eol,
        mixed_eol,
        lines,
        valid_utf8,
        has_nul,
    }
}

/// 由内容与 stat 结果生成基线。
pub fn compute_baseline(bytes: &[u8], size: u64, mtime: u64) -> Baseline {
    let digest = Sha256::digest(bytes);
    Baseline {
        size,
        mtime,
        sha256: hex(&digest),
    }
}

/// 打开远端文本文件：路径校验 → 容量闸门 → 读取 → 嗅探 → 生成基线。
pub async fn open_document(sftp: &Arc<SftpSession>, path: &str) -> Result<OpenMeta> {
    if is_blocked_path(path) {
        return Err(AppError::Invalid(
            "不允许编辑 /proc、/sys、/dev 下的文件".into(),
        ));
    }

    let resolved = sftp
        .canonicalize(path)
        .await
        .map_err(|e| AppError::Transfer(format!("解析远端路径失败: {e}")))?;
    if is_blocked_path(&resolved) {
        return Err(AppError::Invalid(
            "该路径指向受保护的伪文件系统，不支持编辑".into(),
        ));
    }

    let attrs = sftp
        .metadata(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取远端文件属性失败: {e}")))?;
    if attrs.file_type().is_dir() {
        return Err(AppError::Invalid("目标路径是目录，不是文件".into()));
    }

    let size = attrs.size.unwrap_or(0);
    if size > HARD_LIMIT_BYTES {
        return Err(AppError::Invalid(format!(
            "文件 {} 超过 {:.1} MiB 硬上限，请下载后使用本地编辑器处理",
            resolved,
            HARD_LIMIT_BYTES as f64 / 1024.0 / 1024.0
        )));
    }
    let mtime = attrs.mtime.unwrap_or(0) as u64;
    let mode = attrs.permissions.unwrap_or(0);

    let bytes = sftp
        .read(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取远端文件失败: {e}")))?;
    // attrs.size 可能过期，以实际读到的长度为准再闸一次
    if bytes.len() as u64 > HARD_LIMIT_BYTES {
        return Err(AppError::Invalid(format!(
            "文件 {} 超过 {:.1} MiB 硬上限",
            resolved,
            HARD_LIMIT_BYTES as f64 / 1024.0 / 1024.0
        )));
    }

    let info = analyze_content(&bytes);
    if info.has_nul {
        return Err(AppError::Invalid(
            "检测到二进制内容，该文件不支持在线编辑".into(),
        ));
    }
    if !info.valid_utf8 {
        return Err(AppError::Invalid(
            "文件不是 UTF-8 编码。为避免把配置写成乱码，首版不猜测编码，请下载后使用本地编辑器处理".into(),
        ));
    }
    if info.lines > MAX_LINES {
        return Err(AppError::Invalid(format!(
            "文件共 {} 行，超过 {} 行上限，打开会明显卡顿",
            info.lines, MAX_LINES
        )));
    }

    let soft_limit_mode = bytes.len() as u64 > SOFT_LIMIT_BYTES;
    let baseline = compute_baseline(&bytes, size, mtime);
    let writable = mode & 0o222 != 0;
    // 先算出语言再移动 resolved 到返回结构，避免借用顺序错误
    let language = detect_language(&resolved).to_string();

    let warning = if info.mixed_eol {
        Some("文件混用了 CRLF 与 LF，保存时按多数换行符还原".to_string())
    } else if soft_limit_mode {
        Some("文件较大，已进入简化模式：关闭语法高亮与实时搜索".to_string())
    } else {
        None
    };

    Ok(OpenMeta {
        path: resolved,
        encoding: "utf-8".into(),
        eol: info.eol,
        bom: info.bom,
        mixed_eol: info.mixed_eol,
        language,
        read_only: !writable,
        needs_elevation: !writable,
        mode,
        uid: attrs.uid,
        gid: attrs.gid,
        baseline,
        soft_limit_mode,
        content_base64: BASE64.encode(&bytes),
        warning,
    })
}

// ---------- 保存（链路 A：SFTP 直写） ----------

/// `editor_save` 的请求元数据。内容走 Tauri IPC 的 Raw body，
/// 这些元数据编码成 base64(JSON) 放在 `x-lshell-meta` 请求头里。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMeta {
    pub session_id: String,
    pub path: String,
    pub baseline: Baseline,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub elevation: Option<Elevation>,
}

/// 提权方式。`None` 表示走链路 A；`Some` 走链路 B（sudo）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Elevation {
    Passwordless,
    Password { password: String },
}

/// 保存结果。序列化后带 `status` 字段：`saved` / `conflict`。
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SaveResult {
    Saved {
        baseline: Baseline,
        backup_path: Option<String>,
        mode_warning: Option<String>,
    },
    Conflict {
        remote_base64: String,
        remote_baseline: Baseline,
    },
}

/// 备份 / 临时文件用的唯一后缀：纳秒时间戳 + 随机数。
fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let rnd: u32 = rand::random();
    format!("{nanos:x}-{rnd:08x}")
}

fn split_path(path: &str) -> (&str, &str) {
    match path.rsplit_once('/') {
        Some((dir, name)) if !dir.is_empty() => (dir, name),
        Some((_, name)) => ("/", name),
        None => (".", path),
    }
}

/// 基线是否仍然有效。三者全等才算一致。
pub fn baseline_matches(actual: &Baseline, expected: &Baseline) -> bool {
    actual == expected
}

/// 链路 A：SFTP 直写。
///
/// 两次 rename 的目标路径都不存在，从而绕开 russh-sftp 的 Rename 包
/// 不带 OVERWRITE 标志带来的服务端差异（见设计文档 §5.2）。
pub async fn save_document(
    sftp: &Arc<SftpSession>,
    path: &str,
    content: &[u8],
    expected: &Baseline,
    force: bool,
) -> Result<SaveResult> {
    if is_blocked_path(path) {
        return Err(AppError::Invalid("不允许写该系统路径下的文件".into()));
    }

    let resolved = sftp
        .canonicalize(path)
        .await
        .map_err(|e| AppError::Transfer(format!("解析远端路径失败: {e}")))?;

    let attrs = sftp
        .metadata(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取远端文件属性失败: {e}")))?;
    let remote_bytes = sftp
        .read(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取远端文件失败: {e}")))?;
    let actual = compute_baseline(
        &remote_bytes,
        attrs.size.unwrap_or(0),
        attrs.mtime.unwrap_or(0) as u64,
    );

    if !force && !baseline_matches(&actual, expected) {
        return Ok(SaveResult::Conflict {
            remote_base64: BASE64.encode(&remote_bytes),
            remote_baseline: actual,
        });
    }

    let mode = attrs.permissions.unwrap_or(0o644);
    let (dir, name) = split_path(&resolved);
    let suffix = unique_suffix();
    let tmp_path = format!("{dir}/.{name}.lshell-{suffix}.tmp");
    let backup_path = format!("{dir}/{name}.lshell.bak.{suffix}");

    // 1. 创建同目录临时文件，并在创建请求里直接带上原文件的 mode。
    //    高层 SftpSession 不暴露 setstat，所以不能在写完后 chmod；
    //    SFTP 的创建请求允许携带 FileAttributes，OpenSSH 会据此设置权限。
    //    EXCLUDE 确保不会误覆盖同名临时文件。
    {
        let mut file = sftp
            .open_with_flags_and_attributes(
                &tmp_path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(mode),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| AppError::Transfer(format!("创建临时文件失败: {e}")))?;
        file.write_all(content)
            .await
            .map_err(|e| AppError::Transfer(format!("写入临时文件失败: {e}")))?;
        file.close()
            .await
            .map_err(|e| AppError::Transfer(format!("关闭临时文件失败: {e}")))?;
    }

    // 2. 原文件移为备份；成功后目标路径不存在
    if let Err(e) = sftp.rename(&resolved, &backup_path).await {
        let _ = sftp.remove_file(&tmp_path).await;
        return Err(AppError::Transfer(format!("备份原文件失败: {e}")));
    }

    // 3. 临时文件转正；失败则回滚备份
    if let Err(e) = sftp.rename(&tmp_path, &resolved).await {
        let _ = sftp.remove_file(&tmp_path).await;
        if let Err(rb) = sftp.rename(&backup_path, &resolved).await {
            return Err(AppError::Transfer(format!(
                "写入失败且自动回滚失败：{e}；请从备份 {backup_path} 手动恢复（回滚错误：{rb}）"
            )));
        }
        return Err(AppError::Transfer(format!("写入远端文件失败: {e}")));
    }

    // 5. 复查 mode（S4：部分 SFTP 服务端会忽略 setstat）
    let after = sftp.metadata(&resolved).await.ok();
    let mode_warning = after
        .as_ref()
        .and_then(|a| a.permissions)
        .filter(|p| *p != mode)
        .map(|p| format!("权限未恢复：期望 {:o}，实际 {:o}；请手动 chmod", mode, p));

    let final_attrs = sftp
        .metadata(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取保存后属性失败: {e}")))?;
    let new_baseline = compute_baseline(
        content,
        final_attrs.size.unwrap_or(0),
        final_attrs.mtime.unwrap_or(0) as u64,
    );

    // 备份只是在两次 rename 之间兜底回滚用的；保存已经成功，不再留在同目录。
    // 删除失败不视为保存失败（新文件已完整写入），仅保留原样供手动清理。
    let _ = sftp.remove_file(&backup_path).await;

    Ok(SaveResult::Saved {
        baseline: new_baseline,
        backup_path: None,
        mode_warning,
    })
}

/// 远端提权写入脚本。
///
/// 路径与参数通过 `sh -c '...' -- $1 $2 ...` 传入，绝不拼接进脚本正文。
/// 脚本内不使用单引号，以便整体被单引号安全包裹。
/// READY 握手：脚本由 sudo 成功启动后才打印 LSHELL_READY，
/// 因此客户端收到它即可确认密码已被接受，再推送文件内容。
const ELEVATED_SCRIPT: &str = r#"
set -eu
target=$1; mode=$2; owner=$3; stamp=$4; expected=$5; force=$6
cur=$(stat -c %s:%Y -- "$target" 2>/dev/null || printf missing)
if [ "$force" != 1 ] && [ "$cur" != "$expected" ]; then
  printf "LSHELL_CONFLICT\n" >&2
  exit 3
fi
dir=$(dirname -- "$target")
tmp=$(mktemp "$dir/.lshell-XXXXXX")
cleanup() { rm -f -- "$tmp"; }
trap cleanup EXIT
printf "LSHELL_READY\n" >&2
cat > "$tmp"
if [ -e "$target" ]; then cp -p -- "$target" "$target.lshell.bak.$stamp"; fi
chmod "$mode" -- "$tmp"
chown "$owner" -- "$tmp" 2>/dev/null || true
mv -f -- "$tmp" "$target"
rm -f -- "$target.lshell.bak.$stamp" || true
trap - EXIT
"#;

/// POSIX shell 单引号转义。用于把参数安全地嵌入远端命令。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 链路 B：sudo 提权保存。
///
/// - B1（免密）：`sudo -n`，零密码处理。
/// - B2（密码）：`sudo -S -p ''`，密码只在内存与 stdin 中存在，离开作用域即清零。
///
/// 两条路径都在同一个 exec 内完成验证与写入，不依赖 sudo timestamp 缓存。
pub async fn save_elevated(
    sftp: &Arc<SftpSession>,
    conn: &Arc<tokio::sync::Mutex<ssh::SshSession>>,
    path: &str,
    content: &[u8],
    expected: &Baseline,
    force: bool,
    elevation: &Elevation,
) -> Result<SaveResult> {
    if is_blocked_path(path) {
        return Err(AppError::Invalid("不允许写该系统路径下的文件".into()));
    }

    // 先用 SFTP 做一次基线复核，避免无谓的提权
    let resolved = sftp
        .canonicalize(path)
        .await
        .map_err(|e| AppError::Transfer(format!("解析远端路径失败: {e}")))?;
    let attrs = sftp
        .metadata(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取远端文件属性失败: {e}")))?;
    let remote = sftp
        .read(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取远端文件失败: {e}")))?;
    let actual = compute_baseline(
        &remote,
        attrs.size.unwrap_or(0),
        attrs.mtime.unwrap_or(0) as u64,
    );
    if !force && !baseline_matches(&actual, expected) {
        return Ok(SaveResult::Conflict {
            remote_base64: BASE64.encode(&remote),
            remote_baseline: actual,
        });
    }

    let mode = attrs.permissions.unwrap_or(0o644);
    let mode_str = format!("{mode:o}");
    let owner = match (attrs.uid, attrs.gid) {
        (Some(uid), Some(gid)) => format!("{uid}:{gid}"),
        _ => String::new(),
    };
    let expected_stat = format!("{}:{}", expected.size, expected.mtime);
    let force_str = if force { "1" } else { "0" };
    let suffix = unique_suffix();

    let args = [
        resolved.as_str(),
        mode_str.as_str(),
        owner.as_str(),
        suffix.as_str(),
        expected_stat.as_str(),
        force_str,
    ]
    .iter()
    .map(|s| shell_quote(s))
    .collect::<Vec<_>>()
    .join(" ");

    let command = match elevation {
        Elevation::Passwordless => format!(
            "sudo -n sh -c {} -- {args}",
            shell_quote(ELEVATED_SCRIPT.trim())
        ),
        Elevation::Password { .. } => format!(
            "sudo -S -p '' sh -c {} -- {args}",
            shell_quote(ELEVATED_SCRIPT.trim())
        ),
    };

    let session = conn.lock().await;
    let mut exec = ssh::InteractiveExec::start(&session, &command).await?;

    // 密码只在这个作用域内存活；Zeroizing 在离开作用域时清零。
    if let Elevation::Password { password } = elevation {
        {
            let secret = Zeroizing::new(password.as_bytes().to_vec());
            exec.write_stdin(&secret).await?;
            exec.write_stdin(b"\n").await?;
        }
    }

    // 必须与脚本 printf 的完整输出一致（含换行）：wait_for_any 用 ends_with 匹配
    const READY: &[u8] = b"LSHELL_READY\n";
    const CONFLICT: &[u8] = b"LSHELL_CONFLICT\n";
    let markers: &[&[u8]] = &[READY, CONFLICT];
    match exec.wait_for_any(markers, Duration::from_secs(10)).await? {
        WaitResult::Marker(0) => {}
        WaitResult::Marker(1) => {
            return Ok(SaveResult::Conflict {
                remote_base64: BASE64.encode(&remote),
                remote_baseline: actual,
            });
        }
        other => {
            return Err(AppError::Connection(format!(
                "提权校验未通过（{other:?}），文件内容未发送"
            )));
        }
    }

    // 只有确认 sudo 已成功启动脚本后才推送内容
    exec.write_stdin(content).await?;
    let output = exec.finish(Duration::from_secs(60)).await?;
    if output.exit_status != Some(0) {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Transfer(format!(
            "提权保存失败（退出码 {:?}）：{}",
            output.exit_status,
            if reason.is_empty() { "无错误输出" } else { &reason }
        )));
    }

    let final_attrs = sftp
        .metadata(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取保存后属性失败: {e}")))?;
    Ok(SaveResult::Saved {
        baseline: compute_baseline(
            content,
            final_attrs.size.unwrap_or(0),
            final_attrs.mtime.unwrap_or(0) as u64,
        ),
        backup_path: None,
        mode_warning: None,
    })
}

/// 列出目标文件的历史备份，按创建时间倒序（文件名后缀自带纳秒时间戳）。
pub async fn list_backups(sftp: &Arc<SftpSession>, path: &str) -> Result<Vec<String>> {
    let resolved = sftp
        .canonicalize(path)
        .await
        .map_err(|e| AppError::Transfer(format!("解析远端路径失败: {e}")))?;
    let (dir, name) = split_path(&resolved);
    let entries = sftp
        .read_dir(dir)
        .await
        .map_err(|e| AppError::Transfer(format!("读取备份目录失败: {e}")))?;
    let prefix = format!("{name}.lshell.bak.");
    let mut out: Vec<String> = entries
        .into_iter()
        .filter(|e| e.file_name().starts_with(&prefix))
        .map(|e| e.path())
        .collect();
    out.sort_by(|a, b| b.cmp(a));
    Ok(out.into_iter().take(20).collect())
}

/// 从备份恢复。同样用两步 rename，且恢复前也做一次基线复核。
pub async fn restore_backup(
    sftp: &Arc<SftpSession>,
    path: &str,
    backup_path: &str,
    expected: Option<&Baseline>,
    force: bool,
) -> Result<SaveResult> {
    let resolved = sftp
        .canonicalize(path)
        .await
        .map_err(|e| AppError::Transfer(format!("解析远端路径失败: {e}")))?;
    if is_blocked_path(backup_path) {
        return Err(AppError::Invalid("备份路径不合法".into()));
    }

    if let Some(expected) = expected {
        let attrs = sftp
            .metadata(&resolved)
            .await
            .map_err(|e| AppError::Transfer(format!("读取远端文件属性失败: {e}")))?;
        let bytes = sftp
            .read(&resolved)
            .await
            .map_err(|e| AppError::Transfer(format!("读取远端文件失败: {e}")))?;
        let actual = compute_baseline(
            &bytes,
            attrs.size.unwrap_or(0),
            attrs.mtime.unwrap_or(0) as u64,
        );
        if !force && !baseline_matches(&actual, expected) {
            return Ok(SaveResult::Conflict {
                remote_base64: BASE64.encode(&bytes),
                remote_baseline: actual,
            });
        }
    }

    let backup_bytes = sftp
        .read(backup_path)
        .await
        .map_err(|e| AppError::Transfer(format!("读取备份失败: {e}")))?;
    let (dir, name) = split_path(&resolved);
    let suffix = unique_suffix();
    let rollback_path = format!("{dir}/{name}.lshell.pre-restore.{suffix}");

    if let Err(e) = sftp.rename(&resolved, &rollback_path).await {
        return Err(AppError::Transfer(format!("移动当前文件失败: {e}")));
    }
    if let Err(e) = sftp.rename(backup_path, &resolved).await {
        let _ = sftp.rename(&rollback_path, &resolved).await;
        return Err(AppError::Transfer(format!("恢复备份失败: {e}")));
    }
    // 备份是原文件的 rename，mode/uid/gid 已经随 inode 保留，无需额外 setstat。

    let attrs = sftp
        .metadata(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取恢复后属性失败: {e}")))?;
    Ok(SaveResult::Saved {
        baseline: compute_baseline(
            &backup_bytes,
            attrs.size.unwrap_or(0),
            attrs.mtime.unwrap_or(0) as u64,
        ),
        backup_path: Some(rollback_path),
        mode_warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_paths() {
        assert!(is_blocked_path("/proc/self/cmdline"));
        assert!(is_blocked_path("/sys/kernel/foo"));
        assert!(is_blocked_path("/dev/null"));
        assert!(!is_blocked_path("/etc/nginx/nginx.conf"));
        assert!(!is_blocked_path("/home/user/proc/file"));
    }

    #[test]
    fn language_mapping_covers_server_files() {
        assert_eq!(detect_language("/etc/nginx/nginx.conf"), "nginx");
        assert_eq!(detect_language("/etc/ssh/sshd_config"), "ssh_config");
        assert_eq!(detect_language("/etc/systemd/system/x.service"), "ini");
        assert_eq!(detect_language("/srv/Dockerfile"), "dockerfile");
        assert_eq!(detect_language("/srv/Makefile"), "makefile");
        assert_eq!(detect_language("/etc/hosts"), "properties");
        assert_eq!(detect_language("/etc/apt/sources.list.d/x.list"), "properties");
        assert_eq!(detect_language("deploy.yml"), "yaml");
        assert_eq!(detect_language("main.tsx"), "javascript");
        assert_eq!(detect_language("README.unknown"), "plaintext");
    }

    #[test]
    fn sniff_eol_bom_and_lines() {
        let lf = analyze_content(b"a\nb\n");
        assert_eq!(lf.eol, EolKind::Lf);
        assert!(!lf.mixed_eol);
        assert_eq!(lf.lines, 3);

        let crlf = analyze_content(b"a\r\nb\r\n");
        assert_eq!(crlf.eol, EolKind::Crlf);

        let mixed = analyze_content(b"a\r\nb\nc\n");
        assert!(mixed.mixed_eol);
        assert_eq!(mixed.eol, EolKind::Lf);

        let with_bom = analyze_content(&[0xEF, 0xBB, 0xBF, b'a', b'\n']);
        assert!(with_bom.bom);
        assert!(with_bom.valid_utf8);
    }

    #[test]
    fn sniff_rejects_binary_and_non_utf8() {
        let binary = analyze_content(&[b'a', 0, b'b']);
        assert!(binary.has_nul);
        let invalid = analyze_content(&[0xFF, 0xFE, 0xFD]);
        assert!(!invalid.valid_utf8);
    }

    #[test]
    fn shell_quote_blocks_injection() {
        assert_eq!(shell_quote("plain"), "'plain'");
        let evil = "/tmp/a'$(touch /tmp/x)';echo pwned";
        let quoted = shell_quote(evil);
        // 内部每个单引号都被拆成「引号结束 + 转义引号 + 引号开始」三段，
        // 使 $(...) 始终落在外层单引号的保护范围内。
        assert_eq!(
            quoted,
            "'/tmp/a'\\''$(touch /tmp/x)'\\'';echo pwned'"
        );
        assert_eq!(quoted.matches("\\''").count(), 2);
    }

    #[test]
    fn baseline_is_stable_and_content_sensitive() {
        let a = compute_baseline(b"hello", 5, 100);
        let b = compute_baseline(b"hello", 5, 100);
        let c = compute_baseline(b"hallo", 5, 100);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.sha256.len(), 64);
    }
}
