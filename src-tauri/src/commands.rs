//! Tauri 命令层：前端与 Rust 之间的全部接口
//!
//! 约定：
//! - 终端数据流走自定义二进制通道，不经过这里的 JSON 命令
//! - 状态变更通过 event 推送
//! - 其余均为结构化数据，用 JSON 返回

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tauri::ipc::InvokeBody;
use tauri::{Emitter, Manager, State};

use crate::db::now_secs;
use crate::error::{AppError, Result};
use crate::importer;
use crate::proxy::{ProxyConfig, ProxyKind};
use crate::transfer;
use crate::models::{self, AppInfo, Forward, Group, Host, HostInput, HostQuery, KnownHost, Tag};
use crate::session;
use crate::ssh;
use crate::state::{self, AppState};
use crate::vault;

// ---------- 应用 ----------

#[tauri::command]
pub fn app_data_dir() -> Result<String> {
    Ok(crate::data_dir().to_string_lossy().into_owned())
}

/// 显式退出：绕过「关闭到托盘」的设置（对应 Ctrl+Q 与托盘菜单的退出）
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 应用元信息：名称、版本、作者、简介
///
/// 取值全部来自 Cargo.toml 的编译期环境变量，
/// 与打包元数据（tauri.conf.json 的 bundle.publisher / copyright）同源，
/// 不会出现「界面写一个版本号、安装包写另一个」的漂移。
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        // Cargo.toml 里 authors 是数组，这里取第一个作为展示作者
        author: env!("CARGO_PKG_AUTHORS")
            .split(',')
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
        description: env!("CARGO_PKG_DESCRIPTION").to_string(),
    }
}

// ---------- 主机 ----------

/// 解析搜索框输入：`tag:xxx` 走标签过滤，其余为模糊匹配
fn parse_query(state: &State<'_, AppState>, raw: Option<String>) -> Result<HostQuery> {
    let Some(raw) = raw else {
        return Ok(HostQuery::default());
    };
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix("tag:") {
        let name = rest.trim();
        if name.is_empty() {
            return Ok(HostQuery::default());
        }
        // 标签名不存在时返回空结果，而不是回退到全量
        let tag_id = state.db()?.list_tags()?.into_iter().find(|t| t.name == name).map(|t| t.id);
        return Ok(HostQuery {
            text: None,
            tag_id,
        });
    }
    Ok(HostQuery {
        text: if raw.is_empty() { None } else { Some(raw.to_string()) },
        tag_id: None,
    })
}

#[tauri::command]
pub fn list_hosts(state: State<'_, AppState>, search: Option<String>) -> Result<Vec<Host>> {
    let query = parse_query(&state, search)?;
    Ok(state.db()?.list_hosts(&query)?)
}

#[tauri::command]
pub fn get_host(state: State<'_, AppState>, id: i64) -> Result<Option<Host>> {
    Ok(state.db()?.get_host(id)?)
}

#[tauri::command]
pub fn save_host(state: State<'_, AppState>, input: HostInput, id: Option<i64>) -> Result<i64> {
    if input.alias.trim().is_empty() {
        return Err(AppError::Invalid("别名不能为空".into()));
    }
    if input.address.trim().is_empty() {
        return Err(AppError::Invalid("地址不能为空".into()));
    }
    if !matches!(input.auth_type.as_str(), "password" | "key" | "agent") {
        return Err(AppError::Invalid(format!("未知认证方式: {}", input.auth_type)));
    }
    if input.auth_type == "key" && input.key_path.is_none() {
        return Err(AppError::Invalid("私钥认证必须指定私钥文件".into()));
    }

    let proxy_type = input
        .proxy_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("none")
        .to_ascii_lowercase();
    if !matches!(proxy_type.as_str(), "none" | "http" | "socks5") {
        return Err(AppError::Invalid(format!("未知代理类型: {proxy_type}")));
    }
    if proxy_type != "none"
        && (input.proxy_host.as_deref().unwrap_or("").trim().is_empty()
            || input.proxy_port.unwrap_or(0) == 0)
    {
        return Err(AppError::Invalid("使用代理时必须填写代理地址与端口".into()));
    }
    let encoding = input
        .encoding
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("utf-8")
        .to_ascii_lowercase();
    if !matches!(encoding.as_str(), "utf-8" | "utf8" | "gbk" | "big5") {
        return Err(AppError::Invalid(format!("未知字符集: {encoding}")));
    }
    let jump_host_id = input.jump_host_id.filter(|id| *id > 0);
    if let (Some(existing), Some(jump)) = (id, jump_host_id) {
        if existing == jump {
            return Err(AppError::Invalid("跳板机不能是主机自身".into()));
        }
    }

    let host = Host {
        id: id.unwrap_or(0),
        alias: input.alias.trim().to_string(),
        address: input.address.trim().to_string(),
        port: input.port,
        username: input.username.clone(),
        auth_type: input.auth_type.clone(),
        group_id: input.group_id,
        note: input.note.clone(),
        key_path: input.key_path.clone(),
        sort_order: 0,
        created_at: now_secs(),
        last_used_at: None,
        tags: Vec::new(),
        proxy_type,
        proxy_host: input
            .proxy_host
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string(),
        proxy_port: input.proxy_port.unwrap_or(0),
        proxy_username: input
            .proxy_username
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string(),
        jump_host_id,
        term: input.term.as_deref().unwrap_or("").trim().to_string(),
        encoding,
        startup_command: input.startup_command.as_deref().unwrap_or("").to_string(),
    };

    // 凭据落库：仅在提供明文时写入新记录，否则保留原引用
    let password_id = match (&input.password, id) {
        (Some(pwd), _) if !pwd.is_empty() => {
            Some(state::store_secret(&state, "password", pwd, &host.alias)?)
        }
        (_, Some(existing)) => state.db()?.secret_ids_for_host(existing)?.0,
        _ => None,
    };

    let key_pass_id = match (&input.key_passphrase, id) {
        (Some(pass), _) if !pass.is_empty() => {
            Some(state::store_secret(&state, "passphrase", pass, &host.alias)?)
        }
        (_, Some(existing)) => state.db()?.secret_ids_for_host(existing)?.2,
        _ => None,
    };

    let proxy_password_id = match (&input.proxy_password, id) {
        (Some(pwd), _) if !pwd.is_empty() => Some(state::store_secret(
            &state,
            "password",
            pwd,
            &format!("{} 代理", host.alias),
        )?),
        (_, Some(existing)) => state.db()?.secret_ids_for_host(existing)?.3,
        _ => None,
    };

    let host_id = match id {
        Some(existing) => {
            state
                .db()?
                .update_host(existing, &host, password_id, key_pass_id, proxy_password_id)?;
            existing
        }
        None => state
            .db()?
            .insert_host(&host, password_id, None, key_pass_id, proxy_password_id)?,
    };

    state.db()?.set_host_tags(host_id, &input.tag_ids)?;
    Ok(host_id)
}

#[tauri::command]
pub fn delete_host(state: State<'_, AppState>, id: i64) -> Result<()> {
    Ok(state.db()?.delete_host(id)?)
}

/// 复制主机：沿用原主机的地址、端口、用户名、认证方式、分组、备注、标签
/// 以及凭据引用，只生成新的别名并排在原主机后面。
///
/// 凭据只复制 `password_id` / `key_id` / `key_pass_id` 这三个密文引用，
/// 全程不读取也不落地明文；密文仍由原记录持有，不会多存一份。
#[tauri::command]
pub fn duplicate_host(state: State<'_, AppState>, id: i64) -> Result<Host> {
    let db = state.db()?;
    let src = db
        .get_host(id)?
        .ok_or_else(|| AppError::NotFound(format!("主机 {id} 不存在")))?;

    // 别名去重：优先「xxx 副本」，被占用则「xxx 副本 (2)」「xxx 副本 (3)」…
    let alias = {
        let all = db.list_hosts(&HostQuery::default())?;
        let taken: std::collections::HashSet<&str> =
            all.iter().map(|h| h.alias.as_str()).collect();
        let base = format!("{} 副本", src.alias);
        if !taken.contains(base.as_str()) {
            base
        } else {
            let mut n = 2u32;
            loop {
                let candidate = format!("{base} ({n})");
                if !taken.contains(candidate.as_str()) {
                    break candidate;
                }
                n += 1;
            }
        }
    };

    let (password_id, key_id, key_pass_id, proxy_password_id) = db.secret_ids_for_host(id)?;

    let copy = Host {
        id: 0,
        alias,
        address: src.address.clone(),
        port: src.port,
        username: src.username.clone(),
        auth_type: src.auth_type.clone(),
        group_id: src.group_id,
        note: src.note.clone(),
        key_path: src.key_path.clone(),
        sort_order: src.sort_order + 1,
        created_at: now_secs(),
        last_used_at: None,
        tags: src.tags.clone(),
        proxy_type: src.proxy_type.clone(),
        proxy_host: src.proxy_host.clone(),
        proxy_port: src.proxy_port,
        proxy_username: src.proxy_username.clone(),
        jump_host_id: src.jump_host_id,
        term: src.term.clone(),
        encoding: src.encoding.clone(),
        startup_command: src.startup_command.clone(),
    };
    let new_id = db.insert_host(
        &copy,
        password_id,
        key_id,
        key_pass_id,
        proxy_password_id,
    )?;

    // 标签沿用原主机
    let tag_ids: Vec<i64> = src.tags.iter().map(|t| t.id).collect();
    db.set_host_tags(new_id, &tag_ids)?;

    // 排到原主机后面：重写同组顺序（重新读取以包含刚插入的这条）
    let mut order: Vec<i64> = db
        .list_hosts(&HostQuery::default())?
        .into_iter()
        .filter(|h| h.group_id == src.group_id && h.id != new_id)
        .map(|h| h.id)
        .collect();
    let at = order
        .iter()
        .position(|&x| x == id)
        .map(|i| i + 1)
        .unwrap_or(order.len());
    order.insert(at, new_id);
    db.reorder_hosts(src.group_id, &order)?;

    db.get_host(new_id)?
        .ok_or_else(|| AppError::Internal("复制后未找到新主机".into()))
}

// ---------- 主机导入导出 ----------

/// 最近连接的主机
#[tauri::command]
pub fn list_recent_hosts(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Host>> {
    Ok(state.db()?.list_recent_hosts(limit.unwrap_or(6).clamp(1, 30))?)
}

fn resolve_import_path(path: Option<String>) -> std::path::PathBuf {
    match path {
        Some(p) if !p.trim().is_empty() => importer::expand_home(p.trim()),
        _ => importer::default_ssh_config_path(),
    }
}

/// 读取并解析导入文件，返回 (候选, 警告, 格式标识)
fn read_import_file(
    path: &std::path::Path,
) -> Result<(Vec<models::ImportCandidate>, Vec<models::ImportWarning>, &'static str)> {
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Invalid(format!("无法读取 {}: {e}", path.display())))?;
    // ssh config 偶尔会被编辑器存成带 BOM 或非 UTF-8，这里按宽松解码，
    // 避免整个导入因为一个奇怪字符失败
    let text = String::from_utf8_lossy(&bytes);

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let head = text.trim_start();
    let is_json = ext == "json" || head.starts_with('{') || head.starts_with('[');

    if is_json {
        let (candidates, warnings) = importer::parse_json(&text)
            .map_err(|e| AppError::Invalid(format!("{}: {e}", path.display())))?;
        Ok((candidates, warnings, "json"))
    } else {
        let base = path.parent().unwrap_or(std::path::Path::new("."));
        let parsed = importer::parse_ssh_config(&text, base);
        Ok((parsed.candidates, parsed.warnings, "sshConfig"))
    }
}

/// 是否与库里已有的主机重复：地址（不区分大小写）+ 端口 + 用户名
fn is_duplicate(c: &models::ImportCandidate, existing: &[Host]) -> bool {
    existing.iter().any(|h| {
        h.address.eq_ignore_ascii_case(c.address.trim())
            && h.port == c.port
            && h.username.eq_ignore_ascii_case(c.username.trim())
    })
}

/// 预检：读取文件、解析并统计重复项，不写库
#[tauri::command]
pub fn preview_host_import(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<models::ImportPreview> {
    let path = resolve_import_path(path);
    let (candidates, warnings, format) = read_import_file(&path)?;
    let existing = state.db()?.list_hosts(&HostQuery::default())?;
    let duplicates = candidates
        .iter()
        .filter(|c| is_duplicate(c, &existing))
        .count();
    Ok(models::ImportPreview {
        path: path.to_string_lossy().into_owned(),
        format: format.to_string(),
        candidates,
        warnings,
        duplicates,
    })
}

/// 执行导入。重复的主机（同地址+端口+用户名）会被跳过，不覆盖已有配置；
/// 导入完成后按别名/地址把 ProxyJump 解析成跳板机引用。
#[tauri::command]
pub fn import_hosts(state: State<'_, AppState>, path: Option<String>) -> Result<models::ImportSummary> {
    let path = resolve_import_path(path);
    let (candidates, _warnings, _format) = read_import_file(&path)?;
    let db = state.db()?;

    let mut existing = db.list_hosts(&HostQuery::default())?;
    let mut aliases: Vec<String> = existing.iter().map(|h| h.alias.to_ascii_lowercase()).collect();

    let mut imported = 0usize;
    let mut skipped = 0usize;
    // (新主机 id, ProxyJump 原始值)，等全部插入后再解析，保证能指向同批导入的主机
    let mut pending_jumps: Vec<(i64, String)> = Vec::new();

    for c in candidates {
        if is_duplicate(&c, &existing) {
            skipped += 1;
            continue;
        }
        // 别名重复时加序号，避免侧栏里出现两个同名主机
        let mut alias = c.alias.trim().to_string();
        let mut n = 2;
        while aliases.contains(&alias.to_ascii_lowercase()) {
            alias = format!("{} {}", c.alias.trim(), n);
            n += 1;
        }
        aliases.push(alias.to_ascii_lowercase());

        let has_key = c.key_path.as_deref().map(|p| !p.is_empty()).unwrap_or(false);
        let host = Host {
            id: 0,
            alias: alias.clone(),
            address: c.address.trim().to_string(),
            port: c.port,
            username: c.username.trim().to_string(),
            // 有私钥就按密钥认证；否则用本机 SSH Agent（OpenSSH 的默认行为）
            auth_type: if has_key { "key".into() } else { "agent".into() },
            group_id: None,
            note: c.note.clone(),
            key_path: c.key_path.clone().filter(|p| !p.is_empty()),
            sort_order: 0,
            created_at: now_secs(),
            last_used_at: None,
            tags: Vec::new(),
            proxy_type: "none".into(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_username: String::new(),
            jump_host_id: None,
            term: String::new(),
            encoding: "utf-8".into(),
            startup_command: String::new(),
        };
        let id = db.insert_host(&host, None, None, None, None)?;
        imported += 1;
        if let Some(jump) = c.jump.filter(|j| !j.trim().is_empty() && j.trim() != "none") {
            pending_jumps.push((id, jump));
        }
        existing.push(Host { id, ..host });
    }

    // 第二遍：ProxyJump 可能写成别名、user@host 或 host:port
    for (host_id, raw) in pending_jumps {
        let target = raw
            .rsplit('@')
            .next()
            .unwrap_or(&raw)
            .trim()
            .to_string();
        let (name, port) = match target.rsplit_once(':') {
            Some((h, p)) if h.parse::<std::net::Ipv6Addr>().is_err() => {
                (h.to_string(), p.parse::<i64>().ok())
            }
            _ => (target, None),
        };
        let found = existing.iter().find(|h| {
            (h.alias.eq_ignore_ascii_case(&name) || h.address.eq_ignore_ascii_case(&name))
                && port.map(|p| h.port == p).unwrap_or(true)
                && h.id != host_id
        });
        if let Some(h) = found {
            db.set_host_jump(host_id, Some(h.id))?;
        }
    }

    Ok(models::ImportSummary { imported, skipped })
}

/// 导出主机库（JSON 或 ssh config），返回写入的主机数。
/// 只导出配置，不包含任何密码/口令。
#[tauri::command]
pub fn export_hosts(
    state: State<'_, AppState>,
    path: String,
    format: String,
) -> Result<usize> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("导出路径不能为空".into()));
    }
    let path = importer::expand_home(trimmed);
    let hosts = state.db()?.list_hosts(&HostQuery::default())?;

    // 跳板机 id 到别名的映射：导出时写成 ProxyJump 别名，比裸 id 可读
    let alias_by_id: std::collections::HashMap<i64, String> = hosts
        .iter()
        .map(|h| (h.id, h.alias.clone()))
        .collect();
    let jump_alias = |id: Option<i64>| id.and_then(|i| alias_by_id.get(&i).cloned());

    let content = if format.eq_ignore_ascii_case("sshConfig") || format.eq_ignore_ascii_case("ssh") {
        importer::export_ssh_config(&hosts, &jump_alias)
    } else {
        importer::export_json(&hosts, &jump_alias)
    };

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Invalid(format!("无法创建目录 {}: {e}", parent.display())))?;
        }
    }
    std::fs::write(&path, content)
        .map_err(|e| AppError::Invalid(format!("无法写入 {}: {e}", path.display())))?;
    Ok(hosts.len())
}

// ---------- 标签与分组 ----------

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>> {
    Ok(state.db()?.list_tags()?)
}

#[tauri::command]
pub fn upsert_tag(state: State<'_, AppState>, name: String, color: String) -> Result<Tag> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("标签名不能为空".into()));
    }
    Ok(state.db()?.upsert_tag(name, &color)?)
}

#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, id: i64) -> Result<()> {
    Ok(state.db()?.delete_tag(id)?)
}

#[tauri::command]
pub fn list_groups(state: State<'_, AppState>) -> Result<Vec<Group>> {
    Ok(state.db()?.list_groups()?)
}

#[tauri::command]
pub fn create_group(state: State<'_, AppState>, name: String, parent_id: Option<i64>) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("分组名不能为空".into()));
    }
    Ok(state.db()?.insert_group(name, parent_id)?)
}

#[tauri::command]
pub fn rename_group(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    Ok(state.db()?.rename_group(id, name.trim())?)
}

#[tauri::command]
pub fn delete_group(state: State<'_, AppState>, id: i64) -> Result<()> {
    Ok(state.db()?.delete_group(id)?)
}

/// 拖拽排序：按给定顺序写入分组内主机的 sort_order，并把主机移入该分组。
/// `group_id` 为 None 表示根层（不属于任何分组）。
#[tauri::command]
pub fn reorder_hosts(
    state: State<'_, AppState>,
    group_id: Option<i64>,
    ids: Vec<i64>,
) -> Result<()> {
    Ok(state.db()?.reorder_hosts(group_id, &ids)?)
}

/// 拖拽排序：按给定顺序写入分组的 sort_order
#[tauri::command]
pub fn reorder_groups(state: State<'_, AppState>, ids: Vec<i64>) -> Result<()> {
    Ok(state.db()?.reorder_groups(&ids)?)
}

// ---------- 端口转发 ----------

#[tauri::command]
pub fn list_forwards(state: State<'_, AppState>, host_id: i64) -> Result<Vec<Forward>> {
    Ok(state.db()?.list_forwards(host_id)?)
}

#[tauri::command]
pub fn save_forward(state: State<'_, AppState>, host_id: i64, forward: Forward) -> Result<i64> {
    if forward.local_port < 1 || forward.local_port > 65535 {
        return Err(AppError::Invalid("本地端口超出范围".into()));
    }
    if forward.remote_port < 1 || forward.remote_port > 65535 {
        return Err(AppError::Invalid("远端端口超出范围".into()));
    }
    Ok(state.db()?.upsert_forward(host_id, &forward)?)
}

#[tauri::command]
pub fn delete_forward(state: State<'_, AppState>, id: i64) -> Result<()> {
    Ok(state.db()?.delete_forward(id)?)
}

// ---------- 已知主机 ----------

#[tauri::command]
pub fn list_known_hosts(state: State<'_, AppState>) -> Result<Vec<KnownHost>> {
    Ok(state.db()?.list_known_hosts()?)
}

#[tauri::command]
pub fn delete_known_host(state: State<'_, AppState>, id: i64) -> Result<()> {
    Ok(state.db()?.delete_known_host(id)?)
}

/// 用户确认后写入主机密钥
#[tauri::command]
pub fn trust_host_key(
    state: State<'_, AppState>,
    host: String,
    port: i64,
    algo: String,
    fingerprint: String,
) -> Result<()> {
    // known_hosts 按 (host, port) 精确匹配，记录侧必须和连接侧走同一套归一规则：
    // 否则地址写成 `100.70.05.56:22022` 这类形态时，指纹存的是整串、查的是拆开规整
    // 后的值，确认框每次连接都会重弹。
    let (host, port) = match u16::try_from(port) {
        Ok(default) => {
            let (host, port) = ssh::normalize_address(&host, default);
            (host, port as i64)
        }
        Err(_) => (host, port),
    };
    Ok(state.db()?.insert_known_host(&host, port, &algo, &fingerprint)?)
}

// ---------- 设置 ----------

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    Ok(state.db()?.get_setting(&key)?)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    Ok(state.db()?.set_setting(&key, &value)?)
}

/// 一次性读取全部设置项
#[tauri::command]
pub fn get_all_settings(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>> {
    Ok(state.db()?.list_settings()?)
}

/// 删除某项设置，让前端回落到默认值
#[tauri::command]
pub fn delete_setting(state: State<'_, AppState>, key: String) -> Result<()> {
    Ok(state.db()?.delete_setting(&key)?)
}

// ---------- 终端背景图 ----------

/// 用户选择的单张背景图上限
const BG_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 转成 data URL 时的读取上限（略放宽，兼容复制时的小幅变化）
const BG_DATA_URL_MAX_BYTES: u64 = 10 * 1024 * 1024;

fn background_dir() -> std::path::PathBuf {
    crate::data_dir().join("backgrounds")
}

/// 只接受常见位图格式，避免把任意文件当图片读入内存
fn background_ext(path: &std::path::Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp"))
}

fn background_mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/bmp",
    }
}

/// 简易 base64 编码：项目没有引入 base64 crate，避免为一张背景图扩大依赖
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 把用户选择的图片复制到应用数据目录，返回可持久化的绝对路径。
///
/// 复制而非直接引用原文件：用户之后移动/删除原图时终端背景仍然有效。
#[tauri::command]
pub fn save_terminal_background(source_path: String) -> Result<String> {
    let source = std::path::Path::new(&source_path);
    if !source.is_file() {
        return Err(AppError::Invalid("背景图片不存在或无法读取".into()));
    }
    let ext = background_ext(source).ok_or_else(|| {
        AppError::Invalid("不支持的图片格式，请选择 PNG / JPEG / WebP / BMP".into())
    })?;
    let size = std::fs::metadata(source)
        .map_err(|e| AppError::Internal(format!("读取背景图片失败: {e}")))?
        .len();
    if size > BG_MAX_BYTES {
        return Err(AppError::Invalid(format!(
            "图片过大（{:.1} MB），请选择 8 MB 以内的图片",
            size as f64 / 1024.0 / 1024.0
        )));
    }

    let dir = background_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Internal(format!("创建背景图目录失败: {e}")))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target = dir.join(format!("terminal-{stamp}.{ext}"));
    std::fs::copy(source, &target)
        .map_err(|e| AppError::Internal(format!("复制背景图片失败: {e}")))?;
    Ok(target.to_string_lossy().into_owned())
}

fn is_managed_background(path: &std::path::Path) -> bool {
    let (Ok(canonical), Ok(dir)) = (path.canonicalize(), background_dir().canonicalize()) else {
        return false;
    };
    canonical.starts_with(dir)
}

/// 删除应用数据目录下的背景图；路径不在管理目录内时拒绝，避免误删用户文件。
#[tauri::command]
pub fn delete_terminal_background(path: String) -> Result<()> {
    let target = std::path::Path::new(&path);
    if !target.exists() {
        return Ok(());
    }
    if !is_managed_background(target) {
        return Err(AppError::Invalid("只能删除应用数据目录下的背景图".into()));
    }
    std::fs::remove_file(target)
        .map_err(|e| AppError::Internal(format!("删除背景图失败: {e}")))?;
    Ok(())
}

/// 读取背景图并转成 data URL。
///
/// CSP 只允许 `img-src 'self' data:`，因此不走 asset 协议，
/// 由后端读文件后以 data URL 返回（图片在应用数据目录内，路径可信）。
#[tauri::command]
pub fn terminal_background_data_url(path: String) -> Result<String> {
    let target = std::path::Path::new(&path);
    if !target.is_file() {
        return Err(AppError::NotFound(
            "背景图片已丢失，请在设置里重新选择".into(),
        ));
    }
    let ext = background_ext(target)
        .ok_or_else(|| AppError::Invalid("背景图片格式不支持".into()))?;
    let size = std::fs::metadata(target)
        .map_err(|e| AppError::Internal(format!("读取背景图片失败: {e}")))?
        .len();
    if size > BG_DATA_URL_MAX_BYTES {
        return Err(AppError::Invalid("背景图片过大，无法加载".into()));
    }
    let bytes = std::fs::read(target)
        .map_err(|e| AppError::Internal(format!("读取背景图片失败: {e}")))?;
    Ok(format!(
        "data:{};base64,{}",
        background_mime(&ext),
        base64_encode(&bytes)
    ))
}

/// 判断背景图文件是否还在（用户清理应用数据目录后用来提示）
#[tauri::command]
pub fn terminal_background_exists(path: String) -> Result<bool> {
    Ok(std::path::Path::new(&path).is_file())
}

/// 脱敏显示凭据，仅用于界面提示
#[tauri::command]
pub fn mask_secret(secret: String) -> Result<String> {
    Ok(vault::mask(&secret))
}

// ---------- 命令历史 ----------

/// 记录一条已执行的命令
///
/// 由前端在终端收到回车时调用。落库前做脱敏：口令、token、URL userinfo
/// 等常见敏感值会替换成 `***`，避免凭据以明文留在历史里。
#[tauri::command]
pub fn record_command(
    state: State<'_, AppState>,
    host_id: i64,
    command: String,
    cwd: Option<String>,
) -> Result<i64> {
    let redacted = crate::redact::command(&command);
    Ok(state
        .db()?
        .insert_command(host_id, &redacted, cwd.as_deref().unwrap_or(""))?)
}

/// 列出命令历史
///
/// `host_id` 传 `None` 表示跨全部主机查询。
#[tauri::command]
pub fn list_command_history(
    state: State<'_, AppState>,
    host_id: Option<i64>,
    query: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<models::CommandRecord>> {
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    Ok(state
        .db()?
        .list_commands(host_id, query.as_deref(), limit)?)
}

/// 清空命令历史；`host_id` 传 `None` 表示清空全部
#[tauri::command]
pub fn clear_command_history(
    state: State<'_, AppState>,
    host_id: Option<i64>,
) -> Result<usize> {
    Ok(state.db()?.clear_commands(host_id)?)
}

// ---------- 常用命令片段 ----------

/// 列出全部常用片段（按用户排序）
#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Result<Vec<models::Snippet>> {
    state.db()?.list_snippets()
}

/// 新建或更新一个片段；`id` 传 `None` 表示新建
#[tauri::command]
pub fn save_snippet(
    state: State<'_, AppState>,
    id: Option<i64>,
    name: String,
    command: String,
) -> Result<i64> {
    let name = name.trim();
    let command = command.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("片段名称不能为空".into()));
    }
    if command.is_empty() {
        return Err(AppError::Invalid("片段命令不能为空".into()));
    }
    Ok(state.db()?.upsert_snippet(id, name, command)?)
}

/// 删除一个片段
#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: i64) -> Result<()> {
    state.db()?.delete_snippet(id)
}

// ---------- SSH 会话 ----------

/// 把一台主机的凭据、代理与终端参数装成连接参数，同时产出一份重连快照。
///
/// 私钥会被读进内存供本次握手使用；快照里只留路径和口令，
/// 断线重连时从磁盘重新加载（磁盘上的私钥被替换后立即生效）。
///
/// 跳板机由调用方再套一层（`params.jump` / `spec.jump`），本函数不递归。
fn build_connection(
    state: &AppState,
    host: &Host,
    known_hosts: Vec<ssh::KnownHostEntry>,
    timeout: Option<std::time::Duration>,
) -> Result<(ssh::ConnectParams, session::ReconnectSpec)> {
    let (password_id, _key_id, key_pass_id, proxy_password_id) =
        state.db()?.secret_ids_for_host(host.id)?;

    let password = match password_id {
        Some(id) => Some(state::load_secret(state, id)?),
        None => None,
    };
    let passphrase = match key_pass_id {
        Some(id) => Some(state::load_secret(state, id)?),
        None => None,
    };
    let proxy_password = match proxy_password_id {
        Some(id) => Some(state::load_secret(state, id)?),
        None => None,
    };

    let private_key = match (host.auth_type.as_str(), host.key_path.as_deref()) {
        ("key", Some(path)) => Some(ssh::load_private_key(path, passphrase.as_deref())?),
        _ => None,
    };

    // 代理：类型不为 none 且地址/端口有效时才生效，避免半填的表单变成错误的连接路径
    let proxy = if matches!(host.proxy_type.as_str(), "http" | "socks5")
        && !host.proxy_host.trim().is_empty()
        && host.proxy_port > 0
    {
        Some(ProxyConfig {
            kind: if host.proxy_type == "socks5" {
                ProxyKind::Socks5
            } else {
                ProxyKind::Http
            },
            host: host.proxy_host.trim().to_string(),
            port: host.proxy_port as u16,
            username: Some(host.proxy_username.clone()).filter(|u| !u.is_empty()),
            password: proxy_password,
        })
    } else {
        None
    };

    let params = ssh::ConnectParams {
        host: host.address.clone(),
        port: host.port as u16,
        username: host.username.clone(),
        password: password.clone(),
        private_key,
        use_agent: host.auth_type == "agent",
        keyboard_interactive: host.auth_type == "password",
        proxy: proxy.clone(),
        jump: None,
        known_hosts: known_hosts.clone(),
        keepalive: None,
        timeout,
    };

    let spec = session::ReconnectSpec {
        host: host.address.clone(),
        port: host.port as u16,
        username: host.username.clone(),
        password,
        use_agent: params.use_agent,
        keyboard_interactive: params.keyboard_interactive,
        proxy,
        jump: None,
        term: host.term.clone(),
        encoding: host.encoding.clone(),
        startup_command: host.startup_command.clone(),
        key_path: host.key_path.clone(),
        key_passphrase: passphrase,
        known_hosts,
        keepalive: None,
        timeout,
    };

    Ok((params, spec))
}

/// 连接到主机并打开终端会话
///
/// `channel` 是前端创建的 Tauri 二进制通道，用于回传终端输出。
#[tauri::command]
pub async fn connect_host(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sessions: State<'_, session::SharedSessions>,
    host_id: i64,
    session_id: String,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<models::ConnectOutcome> {
    let host = state
        .db()?
        .get_host(host_id)?
        .ok_or_else(|| AppError::NotFound(format!("主机 {host_id} 不存在")))?;

    // 已记录的主机密钥
    let known_hosts = {
        let db = state.db()?;
        db.list_known_hosts()?
            .into_iter()
            .map(|k| (k.host, k.port, k.algo, k.fingerprint))
            .collect::<Vec<_>>()
    };

    // 连接参数：超时与自动重连来自全局设置（对新建连接生效）
    let (timeout_secs, auto_reconnect) = {
        let db = state.db()?;
        let timeout = db
            .get_setting("conn.timeoutSec")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(15)
            .clamp(5, 120);
        let auto = db
            .get_setting("conn.autoReconnect")
            .ok()
            .flatten()
            .map(|v| v == "1" || v == "true")
            .unwrap_or(true);
        (timeout, auto)
    };
    let connect_timeout = Some(std::time::Duration::from_secs(timeout_secs));

    let (mut params, mut spec) =
        build_connection(state.inner(), &host, known_hosts, connect_timeout)?;

    // 单跳跳板机：目标连接跑在跳板机的 direct-tcpip 通道上
    if let Some(jump_id) = host.jump_host_id {
        let jump_host = state
            .db()?
            .get_host(jump_id)?
            .ok_or_else(|| AppError::NotFound(format!("跳板机 {jump_id} 不存在")))?;
        let (jump_params, jump_spec) = build_connection(
            state.inner(),
            &jump_host,
            params.known_hosts.clone(),
            connect_timeout,
        )?;
        params.jump = Some(Box::new(jump_params));
        spec.jump = Some(Box::new(jump_spec));
    }

    // 先探一次主机密钥：首次见到时把指纹交给前端确认，而不是直接失败
    let session = match ssh::connect(params).await? {
        ssh::ConnectResult::Connected(s) => s,
        ssh::ConnectResult::NeedsHostKeyTrust { fingerprint, algo } => {
            return Ok(models::ConnectOutcome::NeedsHostKeyTrust { fingerprint, algo });
        }
        ssh::ConnectResult::HostKeyChanged {
            fingerprint,
            algo,
            stored_fingerprint,
        } => {
            return Ok(models::ConnectOutcome::HostKeyChanged {
                fingerprint,
                algo,
                stored_fingerprint,
            });
        }
    };

    // 把 Tauri 通道包装成输出回调，会话逻辑不直接依赖 IPC 框架。
    // 通道走原始二进制（Raw），终端输出不经过 JSON 序列化。
    // 顺带统计终端通道的下行字节，供状态栏网速监控使用。
    // 重连后守护任务复用同一个 sink，计数因此跨重连累计。
    let net = session::NetCounters::default();
    let net_for_sink = net.clone();
    let sink: session::OutputSink = Arc::new(move |frame| {
        if frame.first() == Some(&session::FRAME_DATA) {
            net_for_sink.add_rx(frame.len().saturating_sub(1) as u64);
        }
        if let Err(e) = channel.send(tauri::ipc::InvokeResponseBody::Raw(frame)) {
            log::warn!("向前端推送终端数据失败: {e}");
        }
    });

    // shell 就绪信号：远端吐出第一段数据时触发
    let shell_ready = Arc::new(tokio::sync::Notify::new());
    let attachment = session::attach_terminal_with(
        &session,
        sink.clone(),
        Some(Arc::clone(&shell_ready)),
        &host.term,
        &host.encoding,
        &host.startup_command,
    )
    .await?;
    let writer = Arc::clone(&attachment.writer);
    // 上行输入需要把 xterm 的 UTF-8 转回远端字符集
    let encoder = crate::textcodec::Encoder::new(crate::textcodec::Charset::from_label(
        &host.encoding,
    ));

    // 自动转发的规则：首次连接要启动，断线重连后也要接着用
    let forwards = {
        let db = state.db()?;
        db.list_forwards(host_id)?
            .into_iter()
            .filter(|f| f.auto_start)
            .map(|f| session::ForwardRule {
                local_port: f.local_port as u16,
                remote_host: f.remote_host,
                remote_port: f.remote_port as u16,
            })
            .collect::<Vec<_>>()
    };
    let auto_forwards = forwards.clone();

    // 启动守护任务：感知断开、按指数退避自动重连
    let supervisor = session::spawn_supervisor(
        session::SupervisorContext {
            session_id: session_id.clone(),
            host_id,
            alias: host.alias.clone(),
            spec,
            forwards,
            auto_reconnect,
        },
        attachment,
        sink,
        sessions.inner().clone(),
    );

    {
        let mut mgr = sessions.lock().await;
        mgr.insert(
            session_id.clone(),
            session::ActiveSession {
                host_id,
                alias: host.alias.clone(),
                net,
                writer,
                encoder,
                sftp: Arc::new(tokio::sync::Mutex::new(None)),
                conn: Arc::new(tokio::sync::Mutex::new(session)),
                state: session::SessionState::Connected,
                forwards: Vec::new(),
                cwd_tracking: false,
                shell_ready,
                supervisor: Some(supervisor),
            },
        );
    }

    // 首次连接即拉起 auto_start 规则；失败不阻断已建立的会话
    // （常见原因是本地端口被占用），但会汇总成一条提示告知用户
    let mut failed: Vec<serde_json::Value> = Vec::new();
    for rule in auto_forwards {
        let conn = {
            let mgr = sessions.lock().await;
            mgr.conn(&session_id)
        };
        let Some(conn) = conn else { break };
        let started = {
            let session = conn.lock().await;
            session::start_forward(
                &session,
                rule.local_port,
                rule.remote_host.clone(),
                rule.remote_port,
            )
            .await
        };
        match started {
            Ok(listener) => {
                let mut mgr = sessions.lock().await;
                if let Some(s) = mgr.get_mut(&session_id) {
                    s.forwards.push(listener);
                }
            }
            Err(e) => {
                log::warn!("自动启动转发 {} 失败: {e}", rule.local_port);
                failed.push(serde_json::json!({
                    "localPort": rule.local_port,
                    "remoteHost": rule.remote_host,
                    "remotePort": rule.remote_port,
                    "message": e.to_string(),
                }));
            }
        }
    }
    if !failed.is_empty() {
        let _ = app.emit(
            "forward://auto-start-failed",
            serde_json::json!({ "sessionId": session_id, "failures": failed }),
        );
    }

    // 记录最近使用时间
    let _ = state.db()?.touch_host(host_id);
    Ok(models::ConnectOutcome::Connected)
}
/// 关闭会话
#[tauri::command]
pub async fn disconnect_host(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<()> {
    let mut mgr = sessions.lock().await;
    mgr.remove(&session_id);
    Ok(())
}

/// 向终端写入用户输入
#[tauri::command]
pub async fn terminal_write(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    data: Vec<u8>,
) -> Result<()> {
    let (writer, net, encoded) = {
        let mgr = sessions.lock().await;
        let s = mgr
            .get(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;
        (Arc::clone(&s.writer), s.net.clone(), s.encoder.encode(&data))
    };
    session::write_input(&writer, &encoded).await?;
    // 上行字节计数，供状态栏网速监控使用
    net.add_tx(encoded.len() as u64);
    Ok(())
}

/// 会话流量快照（累计字节）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStats {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

/// 查询会话累计流量；网速由前端按两次采样的差值算出
#[tauri::command]
pub async fn session_net_stats(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<NetStats> {
    let net = {
        let mgr = sessions.lock().await;
        mgr.net(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?
    };
    let (rx, tx) = net.snapshot();
    Ok(NetStats {
        rx_bytes: rx,
        tx_bytes: tx,
    })
}

/// 目标主机硬件指标
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetrics {
    pub hostname: String,
    pub os: String,
    pub cpu_model: String,
    pub cores: u32,
    /// CPU 总使用率（0-100）
    pub cpu_percent: u32,
    /// 1/5/15 分钟负载，取不到时为空串
    pub load: String,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub uptime_secs: u64,
}

/// 采集脚本：一条 POSIX sh 命令输出 KEY=VALUE 行。
///
/// CPU 使用率取 /proc/stat 两次采样差值（间隔 0.5 秒）；
/// 内存、磁盘、负载均来自 /proc 与 df，非 Linux 主机上这些字段为空，
/// 前端据此降级为只显示主机名与系统。
const HOST_METRICS_SCRIPT: &str = "\
_h=$(uname -n 2>/dev/null)
_o=$(uname -srm 2>/dev/null)
_c=$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null)
_n=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)
_u=$(cut -d. -f1 /proc/uptime 2>/dev/null)
_l=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)
set -- $(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat 2>/dev/null)
_t1=${1:-0}; _i1=${2:-0}
sleep 0.5
set -- $(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat 2>/dev/null)
_t2=${1:-0}; _i2=${2:-0}
_dt=$((_t2-_t1)); _di=$((_i2-_i1))
_cpu=0
[ \"$_dt\" -gt 0 ] && _cpu=$((100*(_dt-_di)/_dt))
_mt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
_ma=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)
_mt=${_mt:-0}; _ma=${_ma:-0}
_mu=$((_mt-_ma)); [ \"$_mu\" -lt 0 ] && _mu=0
set -- $(df -Pk / 2>/dev/null | awk 'NR==2{print $2, $3}')
echo \"hostname=$_h\"
echo \"os=$_o\"
echo \"cpumodel=$_c\"
echo \"cores=${_n:-0}\"
echo \"uptime=${_u:-0}\"
echo \"load=$_l\"
echo \"cpu=$_cpu\"
echo \"mem=$_mt $_mu\"
echo \"disk=${1:-0} ${2:-0}\"";

/// 解析脚本输出的一行 `KEY=VALUE`
fn metrics_field(out: &str, key: &str) -> String {
    let prefix = format!("{key}=");
    out.lines()
        .find_map(|line| line.strip_prefix(prefix.as_str()))
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 取空格分隔字段中的第 n 个数字（从 0 开始），取不到返回 0
fn metrics_num(out: &str, key: &str, index: usize) -> u64 {
    metrics_field(out, key)
        .split_whitespace()
        .nth(index)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// 单个挂载卷的占用情况（容量单位 1K 块）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MountUsage {
    pub mount: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub percent: u32,
}

/// 解析 `df -Pk` 输出。
///
/// 用 POSIX `-P` 保证每个文件系统只占一行（文件名过长也不会换行），
/// 表头与异常行通过「容量列必须是数字」过滤，兼容 GNU / BusyBox / BSD 的差异。
fn parse_df_mounts(out: &str) -> Vec<MountUsage> {
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in out.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 {
            continue;
        }
        let Ok(total_kb) = cols[1].parse::<u64>() else {
            continue;
        };
        let Ok(used_kb) = cols[2].parse::<u64>() else {
            continue;
        };
        if total_kb == 0 {
            continue;
        }
        // 挂载点可能含空格，取第 6 列及其后的所有内容
        let mount = cols[5..].join(" ");
        if !seen.insert(mount.clone()) {
            continue;
        }
        let percent = cols[4]
            .trim_end_matches('%')
            .parse::<u32>()
            .unwrap_or_else(|_| ((used_kb as f64 / total_kb as f64) * 100.0).round() as u32)
            .min(100);
        rows.push(MountUsage {
            mount,
            total_kb,
            used_kb,
            percent,
        });
    }
    rows.sort_by(|a, b| a.mount.cmp(&b.mount));
    rows
}

/// 远端当前登录用户：单独 exec 通道执行 whoami，不干扰终端
#[tauri::command]
pub async fn session_current_user(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<String> {
    let conn = {
        let mgr = sessions.lock().await;
        mgr.conn(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?
    };

    // whoami 优先；没有该命令的极简环境退回 id -un / $USER
    const SCRIPT: &str =
        "whoami 2>/dev/null || id -un 2>/dev/null || printf '%s' \"${USER:-${LOGNAME:-}}\"";
    let out = {
        let session = conn.lock().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            ssh::exec_capture(&session, SCRIPT),
        )
        .await
        .map_err(|_| AppError::Connection("读取当前用户超时".into()))??
    };

    let user = out.lines().next().unwrap_or_default().trim().to_string();
    if user.is_empty() {
        return Err(AppError::Connection("远端未返回当前用户".into()));
    }
    Ok(user)
}

/// 远端挂载卷占用（df -Pk，另开 exec 通道）
#[tauri::command]
pub async fn session_disk_usage(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<Vec<MountUsage>> {
    let conn = {
        let mgr = sessions.lock().await;
        mgr.conn(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?
    };

    let out = {
        let session = conn.lock().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            ssh::exec_capture(&session, "df -Pk 2>/dev/null"),
        )
        .await
        .map_err(|_| AppError::Connection("读取挂载信息超时".into()))??
    };

    let mounts = parse_df_mounts(&out);
    if mounts.is_empty() {
        return Err(AppError::Connection("远端未返回挂载信息".into()));
    }
    Ok(mounts)
}

/// 读取系统剪贴板文本（Windows 走 Win32 API，绕开 WebView2 的权限限制）
#[tauri::command]
pub fn read_clipboard_text() -> Option<String> {
    crate::clipboard::read_text()
}

/// 采集目标主机硬件信息（另开 exec 通道，不干扰终端）
#[tauri::command]
pub async fn session_host_metrics(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<HostMetrics> {
    let conn = {
        let mgr = sessions.lock().await;
        mgr.conn(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?
    };

    let out = {
        let session = conn.lock().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            ssh::exec_capture(&session, HOST_METRICS_SCRIPT),
        )
        .await
        .map_err(|_| AppError::Connection("采集主机指标超时".into()))?
        ?
    };

    let hostname = metrics_field(&out, "hostname");
    let os = metrics_field(&out, "os");
    if hostname.is_empty() && os.is_empty() {
        return Err(AppError::Connection(
            "远端未返回主机指标（可能不支持 exec 通道）".into(),
        ));
    }
    Ok(HostMetrics {
        hostname,
        os,
        cpu_model: metrics_field(&out, "cpumodel"),
        cores: metrics_num(&out, "cores", 0) as u32,
        cpu_percent: metrics_num(&out, "cpu", 0).min(100) as u32,
        load: metrics_field(&out, "load"),
        mem_total_kb: metrics_num(&out, "mem", 0),
        mem_used_kb: metrics_num(&out, "mem", 1),
        disk_total_kb: metrics_num(&out, "disk", 0),
        disk_used_kb: metrics_num(&out, "disk", 1),
        uptime_secs: metrics_num(&out, "uptime", 0),
    })
}

/// 调整终端尺寸
#[tauri::command]
pub async fn terminal_resize(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    let writer = {
        let mgr = sessions.lock().await;
        mgr.writer(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?
    };
    session::resize(&writer, cols, rows).await
}

/// 查询会话状态
#[tauri::command]
pub async fn session_state(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<Option<session::SessionState>> {
    let mgr = sessions.lock().await;
    Ok(mgr.state(&session_id))
}

/// 让远端 shell 在每次显示提示符前上报当前目录（OSC 7）
///
/// 做法是探测登录 shell → 把跟踪脚本写到远端主目录 → 让交互式 shell 加载。
/// 终端里只会留下一行短命令，不会有一长串脚本。
///
/// 幂等：同一会话只注入一次，重复调用直接返回。
#[tauri::command]
pub async fn session_enable_cwd_tracking(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<()> {
    // 已经注入过就直接返回
    {
        let mgr = sessions.lock().await;
        let s = mgr
            .get(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;
        if s.cwd_tracking {
            return Ok(());
        }
    }

    let (conn, writer, ready) = {
        let mgr = sessions.lock().await;
        let s = mgr
            .get(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;
        (
            Arc::clone(&s.conn),
            Arc::clone(&s.writer),
            Arc::clone(&s.shell_ready),
        )
    };

    // 打开 SFTP 会话（首次访问时才真正建立），脚本写入复用它
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::Transfer("SFTP 会话不可用，无法写入目录跟踪脚本".into()))?;

    session::inject_cwd_tracking(&conn, &sftp, &writer, &ready).await?;

    // 打标记，避免重复注入
    {
        let mut mgr = sessions.lock().await;
        if let Some(s) = mgr.get_mut(&session_id) {
            s.cwd_tracking = true;
        }
    }
    Ok(())
}

// ---------- SFTP ----------

/// 远端目录项
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

/// 目录列举结果：解析后的绝对路径 + 条目
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListing {
    /// 解析后的绝对路径（"." 会解析成用户主目录）
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

/// 列出远端目录
#[tauri::command]
pub async fn sftp_list(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    path: String,
) -> Result<SftpListing> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    // "." 解析成用户主目录，这样面板初始位置就是用户最常看的地方
    let resolved = sftp
        .canonicalize(&path)
        .await
        .map_err(|e| AppError::Transfer(format!("打开目录失败: {e}")))?;

    // 必须用解析后的绝对路径列举：russh-sftp 的条目路径是
    // 「传给 read_dir 的路径 + 文件名」拼出来的，
    // 若传的是 "."，条目路径就会是 "./xxx" 这种相对形式，
    // 后续删除/重命名/下载会依赖服务端的当前工作目录，不可靠。
    let read_dir = sftp
        .read_dir(&resolved)
        .await
        .map_err(|e| AppError::Transfer(format!("读取目录失败: {e}")))?;

    let mut out = Vec::new();
    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        // DirEntry 自带 metadata，无需再发一次 stat 请求
        let meta = entry.metadata();
        let is_dir = meta.file_type().is_dir();
        let size = meta.size.unwrap_or(0);
        let modified = meta.mtime.map(|t| t as u64);
        let path = entry.path();

        out.push(RemoteEntry {
            name,
            path,
            is_dir,
            size,
            modified,
        });
    }

    // 目录在前，同类按名称排序
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(SftpListing {
        path: resolved,
        entries: out,
    })
}

/// 下载远端文件到本地路径
///
/// 传输在后台执行，本命令立即返回传输 id；
/// 进度通过 `list_transfers` 查询，中途放弃用 `cancel_transfer`。
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64> {
    // 覆盖策略：目标是已存在文件时，是否直接跳过（来自全局设置）
    let skip_existing = {
        let db = state.db()?;
        db.get_setting("transfer.overwrite")
            .ok()
            .flatten()
            .map(|v| v == "skip")
            .unwrap_or(false)
    };

    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    // 目录下载不套用单文件覆盖策略：目标目录里本来就可能已有同名文件
    let remote_is_dir = sftp
        .metadata(&remote_path)
        .await
        .ok()
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false);
    if skip_existing && !remote_is_dir && tokio::fs::metadata(&local_path).await.is_ok() {
        return Err(AppError::Transfer(
            "本地已存在同名文件，已按设置跳过下载".into(),
        ));
    }

    let name = transfer::file_name_of(&remote_path);
    let task = state.transfers.start(
        transfer::TransferDirection::Download,
        name,
        local_path.clone(),
        remote_path.clone(),
    );
    let id = task.id();

    let transfers = Arc::clone(&state.transfers);
    let remote = remote_path.clone();
    let local = local_path.clone();
    tokio::spawn(async move {
        let result = transfer::run_download_any(&sftp, &task, &remote, &local).await;
        transfers.finish(&task, result);
    });

    Ok(id)
}

/// 上传本地文件到远端路径
///
/// 传输在后台执行，本命令立即返回传输 id；
/// 进度通过 `list_transfers` 查询，中途放弃用 `cancel_transfer`。
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64> {
    // 覆盖策略：远端目标已存在时，是否直接跳过（来自全局设置）
    let skip_existing = {
        let db = state.db()?;
        db.get_setting("transfer.overwrite")
            .ok()
            .flatten()
            .map(|v| v == "skip")
            .unwrap_or(false)
    };

    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    if skip_existing && sftp.metadata(&remote_path).await.is_ok() {
        return Err(AppError::Transfer(
            "远端已存在同名文件，已按设置跳过上传".into(),
        ));
    }

    // 拖拽/选择可能带进来文件夹，由 run_upload_any 递归处理
    let name = transfer::file_name_of(&local_path);
    let task = state.transfers.start(
        transfer::TransferDirection::Upload,
        name,
        local_path.clone(),
        remote_path.clone(),
    );
    let id = task.id();

    let transfers = Arc::clone(&state.transfers);
    let local = local_path.clone();
    let remote = remote_path.clone();
    tokio::spawn(async move {
        let result = transfer::run_upload_any(&sftp, &task, &local, &remote).await;
        transfers.finish(&task, result);
    });

    Ok(id)
}

/// 列出全部传输任务的状态快照
#[tauri::command]
pub fn list_transfers(state: State<'_, AppState>) -> Vec<transfer::TransferStatus> {
    state.transfers.list()
}

/// 请求取消某个传输；返回是否受理成功
#[tauri::command]
pub fn cancel_transfer(state: State<'_, AppState>, id: u64) -> bool {
    state.transfers.cancel(id)
}

/// 在远端创建目录
#[tauri::command]
pub async fn sftp_mkdir(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    path: String,
) -> Result<()> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    sftp.create_dir(&path)
        .await
        .map_err(|e| AppError::Transfer(format!("创建目录失败: {e}")))?;
    Ok(())
}

/// 在远端创建空文件；EXCLUDE 保证同名文件不会被覆盖
#[tauri::command]
pub async fn sftp_touch(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    path: String,
) -> Result<()> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    let file = sftp
        .open_with_flags_and_attributes(
            &path,
            russh_sftp::protocol::OpenFlags::WRITE
                | russh_sftp::protocol::OpenFlags::CREATE
                | russh_sftp::protocol::OpenFlags::EXCLUDE,
            russh_sftp::protocol::FileAttributes::default(),
        )
        .await
        .map_err(|e| AppError::Transfer(format!("创建文件失败: {e}")))?;
    file.close()
        .await
        .map_err(|e| AppError::Transfer(format!("关闭文件失败: {e}")))?;
    Ok(())
}

/// 递归删除远端目录：先删子项，再删目录自身
///
/// 异步递归必须装箱，否则编译器无法确定 future 尺寸。
async fn remove_remote_tree(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<()> {
    let read_dir = sftp
        .read_dir(path)
        .await
        .map_err(|e| AppError::Transfer(format!("读取目录失败: {e}")))?;
    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child = format!("{}/{}", path.trim_end_matches('/'), name);
        if entry.metadata().file_type().is_dir() {
            Box::pin(remove_remote_tree(sftp, &child)).await?;
        } else {
            sftp.remove_file(&child)
                .await
                .map_err(|e| AppError::Transfer(format!("删除失败: {e}")))?;
        }
    }
    sftp.remove_dir(path)
        .await
        .map_err(|e| AppError::Transfer(format!("删除目录失败: {e}")))?;
    Ok(())
}

/// 删除远端文件或目录（目录递归删除）
#[tauri::command]
pub async fn sftp_remove(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    if is_dir {
        remove_remote_tree(&sftp, &path).await?;
    } else {
        sftp.remove_file(&path)
            .await
            .map_err(|e| AppError::Transfer(format!("删除失败: {e}")))?;
    }
    Ok(())
}

/// 重命名远端文件或目录
#[tauri::command]
pub async fn sftp_rename(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    from_path: String,
    to_path: String,
) -> Result<()> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    sftp.rename(&from_path, &to_path)
        .await
        .map_err(|e| AppError::Transfer(format!("重命名失败: {e}")))?;
    Ok(())
}

// ---------- 远程文件编辑 ----------

/// 打开远端文本文件用于在线编辑。
///
/// 内容以 base64 随元数据一起返回：Tauri 的响应只有 body、没有 headers，
/// 无法像请求方向那样把元数据塞进 headers，而拆成两次调用读远端又会引入
/// TOCTOU（内容与基线可能来自不同版本）。
#[tauri::command]
pub async fn editor_open(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    path: String,
) -> Result<crate::editor::OpenMeta> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    crate::editor::open_document(&sftp, &path).await
}

/// 保存远端文件。
///
/// 内容走 Tauri IPC 的 Raw body（避免 JSON 数组膨胀），元数据放在
/// `x-lshell-meta` 请求头（base64(JSON)）。请求方向支持 Raw 已在 Spike S1 验证。
#[tauri::command]
pub async fn editor_save(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<crate::editor::SaveResult> {
    let meta_raw = request
        .headers()
        .get("x-lshell-meta")
        .ok_or_else(|| AppError::Invalid("缺少 x-lshell-meta 请求头".into()))?
        .to_str()
        .map_err(|_| AppError::Invalid("x-lshell-meta 请求头不是合法文本".into()))?;
    let meta_bytes = BASE64
        .decode(meta_raw)
        .map_err(|e| AppError::Invalid(format!("请求元数据 base64 解码失败: {e}")))?;
    let meta: crate::editor::SaveMeta = serde_json::from_slice(&meta_bytes)
        .map_err(|e| AppError::Invalid(format!("请求元数据解析失败: {e}")))?;

    let InvokeBody::Raw(content) = request.body() else {
        return Err(AppError::Invalid("文件内容必须以二进制 body 传递".into()));
    };

    let sessions = app.state::<session::SharedSessions>();
    let (host_id, conn) = {
        let mgr = sessions.lock().await;
        let active = mgr
            .get(&meta.session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {} 不存在", meta.session_id)))?;
        (active.host_id, active.conn.clone())
    };
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&meta.session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {} 不存在", meta.session_id)))?;

    if let Some(elevation) = &meta.elevation {
        let mode_label = match elevation {
            crate::editor::Elevation::Passwordless => "passwordless",
            crate::editor::Elevation::Password { .. } => "password",
        };
        let outcome = crate::editor::save_elevated(
            &sftp,
            &conn,
            &meta.path,
            content,
            &meta.baseline,
            meta.force,
            elevation,
        )
        .await;

        // 审计只记录路径 / 提权方式 / 结果 / 字节数，绝不记录密码或内容。
        let (result_label, bytes) = match &outcome {
            Ok(crate::editor::SaveResult::Saved { .. }) => ("success", content.len() as i64),
            Ok(crate::editor::SaveResult::Conflict { .. }) => ("conflict", 0i64),
            Err(_) => ("failed", 0i64),
        };
        if let Ok(db) = app.state::<AppState>().db() {
            let _ = db.insert_editor_audit(
                host_id,
                &meta.path,
                mode_label,
                meta.force,
                result_label,
                bytes,
            );
        }
        return outcome;
    }

    crate::editor::save_document(&sftp, &meta.path, content, &meta.baseline, meta.force).await
}

/// 列出文件的历史备份（最多 20 条）。
#[tauri::command]
pub async fn editor_list_backups(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    path: String,
) -> Result<Vec<String>> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;
    crate::editor::list_backups(&sftp, &path).await
}

/// 从备份恢复文件。
#[tauri::command]
pub async fn editor_restore(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    path: String,
    backup_path: String,
    baseline: Option<crate::editor::Baseline>,
    force: Option<bool>,
) -> Result<crate::editor::SaveResult> {
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;
    crate::editor::restore_backup(
        &sftp,
        &path,
        &backup_path,
        baseline.as_ref(),
        force.unwrap_or(false),
    )
    .await
}

/// 列出远程文件编辑审计记录（不含内容与密码）。
#[tauri::command]
pub fn editor_audit_list(
    state: State<'_, AppState>,
    host_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<models::EditorAudit>> {
    Ok(state
        .db()?
        .list_editor_audit(host_id, limit.unwrap_or(50))?)
}

// ---------- 端口转发 ----------

/// 启动一个本地端口转发
#[tauri::command]
pub async fn forward_start(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<()> {
    let conn = {
        let mgr = sessions.lock().await;
        mgr.conn(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?
    };

    let session = conn.lock().await;
    let listener = session::start_forward(
        &session,
        local_port,
        remote_host.clone(),
        remote_port,
    )
    .await?;
    drop(session);

    let mut mgr = sessions.lock().await;
    if let Some(s) = mgr.get_mut(&session_id) {
        s.forwards.push(listener);
    }
    Ok(())
}

/// 停止一个本地端口转发
#[tauri::command]
pub async fn forward_stop(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
    local_port: u16,
) -> Result<()> {
    let mut mgr = sessions.lock().await;
    if let Some(s) = mgr.get_mut(&session_id) {
        s.forwards.retain(|f| {
            if f.local_port == local_port {
                f.task.abort();
                false
            } else {
                true
            }
        });
    }
    Ok(())
}

/// 列出会话当前生效的转发
#[tauri::command]
pub async fn forward_list(
    sessions: State<'_, session::SharedSessions>,
    session_id: String,
) -> Result<Vec<ForwardRuntime>> {
    let mut mgr = sessions.lock().await;
    let s = mgr
        .get_mut(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;
    Ok(s
        .forwards
        .iter()
        .map(|f| ForwardRuntime {
            local_port: f.local_port,
            remote_host: f.remote_host.clone(),
            remote_port: f.remote_port,
        })
        .collect())
}

/// 运行中的转发
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRuntime {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}
