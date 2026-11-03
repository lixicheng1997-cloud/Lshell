//! Tauri 命令层：前端与 Rust 之间的全部接口
//!
//! 约定：
//! - 终端数据流走自定义二进制通道，不经过这里的 JSON 命令
//! - 状态变更通过 event 推送
//! - 其余均为结构化数据，用 JSON 返回

use std::sync::Arc;

use tauri::State;

use crate::db::now_secs;
use crate::error::{AppError, Result};
use crate::transfer;
use crate::models::{self, Forward, Group, Host, HostInput, HostQuery, KnownHost, Tag};
use crate::session;
use crate::ssh;
use crate::state::{self, AppState};
use crate::vault;

// ---------- 应用 ----------

#[tauri::command]
pub fn app_data_dir() -> Result<String> {
    Ok(crate::data_dir().to_string_lossy().into_owned())
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

    let host_id = match id {
        Some(existing) => {
            state.db()?.update_host(existing, &host, password_id, key_pass_id)?;
            existing
        }
        None => state.db()?.insert_host(&host, password_id, key_pass_id)?,
    };

    state.db()?.set_host_tags(host_id, &input.tag_ids)?;
    Ok(host_id)
}

#[tauri::command]
pub fn delete_host(state: State<'_, AppState>, id: i64) -> Result<()> {
    Ok(state.db()?.delete_host(id)?)
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

/// 脱敏显示凭据，仅用于界面提示
#[tauri::command]
pub fn mask_secret(secret: String) -> Result<String> {
    Ok(vault::mask(&secret))
}

// ---------- 命令历史 ----------

/// 记录一条已执行的命令
///
/// 由前端在终端收到回车时调用。命令文本本身不敏感，
/// 但仍然不记录密码输入 —— 前端不会把这类内容送上来。
#[tauri::command]
pub fn record_command(
    state: State<'_, AppState>,
    host_id: i64,
    command: String,
    cwd: Option<String>,
) -> Result<i64> {
    Ok(state
        .db()?
        .insert_command(host_id, &command, cwd.as_deref().unwrap_or(""))?)
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

// ---------- SSH 会话 ----------

/// 连接到主机并打开终端会话
///
/// `channel` 是前端创建的 Tauri 二进制通道，用于回传终端输出。
#[tauri::command]
pub async fn connect_host(
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

    // 读取凭据（保险库未解锁时会报错）
    let (password_id, _key_id, key_pass_id) = state.db()?.secret_ids_for_host(host_id)?;
    let password = match password_id {
        Some(id) => Some(state::load_secret(&state, id)?),
        None => None,
    };
    let passphrase = match key_pass_id {
        Some(id) => Some(state::load_secret(&state, id)?),
        None => None,
    };

    // 加载私钥
    let private_key = match (host.auth_type.as_str(), host.key_path.as_deref()) {
        ("key", Some(path)) => Some(ssh::load_private_key(path, passphrase.as_deref())?),
        _ => None,
    };

    // 已记录的主机密钥
    let known_hosts = {
        let db = state.db()?;
        db.list_known_hosts()?
            .into_iter()
            .map(|k| (k.host, k.port, k.algo, k.fingerprint))
            .collect::<Vec<_>>()
    };

    // 重连用的凭据快照：断线后守护任务靠它重新建立连接。
    // 私钥只记路径，重连时从磁盘重新加载。
    let spec = session::ReconnectSpec {
        host: host.address.clone(),
        port: host.port as u16,
        username: host.username.clone(),
        password: password.clone(),
        key_path: host.key_path.clone(),
        key_passphrase: passphrase.clone(),
        known_hosts: known_hosts.clone(),
        keepalive: None,
        timeout: None,
    };

    let params = ssh::ConnectParams {
        host: host.address.clone(),
        port: host.port as u16,
        username: host.username.clone(),
        password,
        private_key,
        known_hosts,
        keepalive: None,
        timeout: None,
    };

    // 先探一次主机密钥：首次见到时把指纹交给前端确认，而不是直接失败
    let session = match ssh::connect(params).await? {
        ssh::ConnectResult::Connected(s) => s,
        ssh::ConnectResult::NeedsHostKeyTrust { fingerprint, algo } => {
            return Ok(models::ConnectOutcome::NeedsHostKeyTrust { fingerprint, algo });
        }
    };

    // 把 Tauri 通道包装成输出回调，会话逻辑不直接依赖 IPC 框架。
    // 通道走原始二进制（Raw），终端输出不经过 JSON 序列化。
    let sink: session::OutputSink = Arc::new(move |frame| {
        if let Err(e) = channel.send(tauri::ipc::InvokeResponseBody::Raw(frame)) {
            log::warn!("向前端推送终端数据失败: {e}");
        }
    });

    // shell 就绪信号：远端吐出第一段数据时触发
    let shell_ready = Arc::new(tokio::sync::Notify::new());
    let attachment =
        session::attach_terminal_with(&session, sink.clone(), Some(Arc::clone(&shell_ready))).await?;
    let writer = Arc::clone(&attachment.writer);

    // 自动转发的规则：断线重连后要接着用
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

    // 启动守护任务：感知断开、按指数退避自动重连
    let supervisor = session::spawn_supervisor(
        session::SupervisorContext {
            session_id: session_id.clone(),
            host_id,
            alias: host.alias.clone(),
            spec,
            forwards,
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
                writer,
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
    let writer = {
        let mgr = sessions.lock().await;
        mgr.writer(&session_id)
            .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?
    };
    session::write_input(&writer, &data).await
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
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

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
        let result = transfer::run_download(&sftp, &task, &remote, &local).await;
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
    let sftp = {
        let mgr = sessions.lock().await;
        mgr.sftp(&session_id).await
    }
    .ok_or_else(|| AppError::NotFound(format!("会话 {session_id} 不存在")))?;

    // 拖拽可能带进来文件夹，这里直接给出明确提示而不是让远端报一个费解的错
    if let Ok(meta) = tokio::fs::metadata(&local_path).await {
        if meta.is_dir() {
            return Err(AppError::Transfer(
                "暂不支持上传文件夹，请拖入单个文件".into(),
            ));
        }
    }

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
        let result = transfer::run_upload(&sftp, &task, &local, &remote).await;
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

/// 删除远端文件或目录
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

    let result = if is_dir {
        sftp.remove_dir(&path).await
    } else {
        sftp.remove_file(&path).await
    };
    result.map_err(|e| AppError::Transfer(format!("删除失败: {e}")))?;
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
