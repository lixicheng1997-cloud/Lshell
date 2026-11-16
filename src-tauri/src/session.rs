//! 会话管理：Rust 侧持有 SSH 连接，前端只做视图。
//!
//! 每条会话包含一个 shell channel。读半边独占在读取任务中，
//! 写半边用 `Arc` 共享给命令层（写入输入、调整尺寸）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

use crate::error::{AppError, Result};
use crate::ssh::{self, SshSession, WriteHalf};

/// 会话状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Connecting,
    Connected,
    Failed,
    Disconnected,
    /// 连接已断开，正在自动重连
    Reconnecting,
}

/// 会话流量计数器（字节）。
///
/// 只统计终端通道上的数据帧：rx 是远端输出，tx 是用户输入。
/// 用原子计数，读取端（状态栏轮询）与会话读写路径互不阻塞。
#[derive(Clone, Default)]
pub struct NetCounters {
    rx: Arc<AtomicU64>,
    tx: Arc<AtomicU64>,
}

impl NetCounters {
    pub fn add_rx(&self, n: u64) {
        self.rx.fetch_add(n, Ordering::Relaxed);
    }

    pub fn add_tx(&self, n: u64) {
        self.tx.fetch_add(n, Ordering::Relaxed);
    }

    /// (累计接收, 累计发送) 字节
    pub fn snapshot(&self) -> (u64, u64) {
        (
            self.rx.load(Ordering::Relaxed),
            self.tx.load(Ordering::Relaxed),
        )
    }
}

/// 一条活动会话
pub struct ActiveSession {
    pub host_id: i64,
    pub alias: String,
    /// 终端通道流量计数
    pub net: NetCounters,
    /// 终端写半边：共享给命令层，用于写入输入与调整尺寸
    pub writer: Arc<WriteHalf>,
    /// 上行输入编码器（GBK/Big5 时非透传）
    pub encoder: crate::textcodec::Encoder,
    /// SFTP 会话：与终端复用同一条 SSH 连接。
    ///
    /// 用 `Arc` 包一层而不是直接持有，是为了让并发操作共享同一个会话 ——
    /// `SftpSession` 的方法都取 `&self`，内部是多路复用的，本身支持并发。
    /// 若用互斥锁保护，传大文件时会把 SFTP 会话锁死，
    /// 目录列表、新建、删除这些操作会全部卡住。
    pub sftp: Arc<tokio::sync::Mutex<Option<Arc<russh_sftp::client::SftpSession>>>>,
    /// 底层 SSH 连接，转发与 SFTP 都用它
    pub conn: Arc<tokio::sync::Mutex<SshSession>>,
    pub state: SessionState,
    /// 转发监听器，drop 时自动关闭
    pub forwards: Vec<ForwardListener>,
    /// 是否已向远端注入目录上报脚本
    pub cwd_tracking: bool,
    /// 远端输出第一段数据到达时触发，用于判断 shell 已经就绪
    pub shell_ready: Arc<Notify>,
    /// 会话守护任务：负责感知断开并自动重连
    pub supervisor: Option<tokio::task::JoinHandle<()>>,
}

/// 本地端口转发监听器
pub struct ForwardListener {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub task: tokio::task::JoinHandle<()>,
}

/// 会话管理器
#[derive(Default)]
pub struct SessionManager {
    sessions: HashMap<String, ActiveSession>,
}

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            sessions: HashMap::new(),
        }
    }

    pub fn insert(&mut self, id: String, session: ActiveSession) {
        self.sessions.insert(id, session);
    }

    pub fn remove(&mut self, id: &str) -> Option<ActiveSession> {
        let session = self.sessions.remove(id);
        if let Some(s) = &session {
            // 守护任务会一直 await 终端结束信号，必须显式中止，
            // 否则会话关闭后它还在后台空转。
            if let Some(handle) = &s.supervisor {
                handle.abort();
            }
        }
        session
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut ActiveSession> {
        self.sessions.get_mut(id)
    }

    pub fn get(&self, id: &str) -> Option<&ActiveSession> {
        self.sessions.get(id)
    }

    pub fn writer(&self, id: &str) -> Option<Arc<WriteHalf>> {
        self.sessions.get(id).map(|s| Arc::clone(&s.writer))
    }

    /// 取出会话的流量计数器
    pub fn net(&self, id: &str) -> Option<NetCounters> {
        self.sessions.get(id).map(|s| s.net.clone())
    }

    /// 取出会话的底层 SSH 连接（转发用）
    pub fn conn(&self, id: &str) -> Option<Arc<tokio::sync::Mutex<SshSession>>> {
        self.sessions.get(id).map(|s| Arc::clone(&s.conn))
    }

    /// 取出会话的 SFTP 通道；若尚未打开则现场打开一个。
    ///
    /// 返回 `Arc<SftpSession>` 而非互斥保护的槽：`SftpSession` 的所有方法都取 `&self`，
    /// 内部是多路复用的，本身支持并发。传输大文件时不能把会话锁死，
    /// 否则目录列表会被传输卡住。
    pub async fn sftp(&self, id: &str) -> Option<Arc<russh_sftp::client::SftpSession>> {
        let (conn, sftp_slot) = {
            let s = self.sessions.get(id)?;
            (Arc::clone(&s.conn), Arc::clone(&s.sftp))
        };

        // 已有 SFTP 会话直接复用
        // 注意：guard 必须在移动 sftp_slot 之前释放
        let already_open = {
            let guard = sftp_slot.lock().await;
            match guard.as_ref() {
                Some(s) => Some(Arc::clone(s)),
                None => None,
            }
        };
        if let Some(s) = already_open {
            return Some(s);
        }

        // 首次访问时才打开，复用同一条 SSH 连接
        let opened = {
            let session = conn.lock().await;
            Arc::new(ssh::open_sftp(&session).await.ok()?)
        };

        let mut guard = sftp_slot.lock().await;
        // 并发调用时可能已被别人打开，用先到的那份
        if let Some(s) = guard.as_ref() {
            return Some(Arc::clone(s));
        }
        *guard = Some(Arc::clone(&opened));
        Some(opened)
    }

    pub fn state(&self, id: &str) -> Option<SessionState> {
        self.sessions.get(id).map(|s| s.state)
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

/// 终端通道的帧类型。
///
/// 通道走 Tauri 的原始二进制通道（`InvokeResponseBody::Raw`），
/// 不做 JSON 序列化 —— 终端输出是高频字节流，JSON 编码会明显拖慢渲染。
/// 这里用 1 字节帧头区分帧的种类。
pub const FRAME_DATA: u8 = 0x00;
pub const FRAME_CLOSED: u8 = 0x01;
/// 会话状态变化帧：载荷是 [`SessionNotice`] 的 JSON 编码
pub const FRAME_STATUS: u8 = 0x02;

/// 给数据帧加上帧头
pub fn frame_data(data: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 1);
    out.push(FRAME_DATA);
    out.extend_from_slice(&data);
    out
}

/// 会话结束帧
pub fn frame_closed() -> Vec<u8> {
    vec![FRAME_CLOSED]
}

/// 会话状态变化的种类
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeState {
    /// 连接已断开，正在自动重连
    Reconnecting,
    /// 重连成功
    Reconnected,
    /// 重连失败，已放弃重试
    Disconnected,
    /// 远端 shell 正常退出
    Closed,
}

/// 会话状态通知。
///
/// 走终端通道下发给前端，让前端能区分「正在重连」与「彻底断开」——
/// 这两种情况对用户是完全不同的操作指引。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotice {
    pub state: NoticeState,
    /// 当前是第几次重试（从 1 开始）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    /// 下次重试前的等待毫秒数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    /// 面向用户的说明
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SessionNotice {
    pub fn new(state: NoticeState) -> Self {
        SessionNotice {
            state,
            attempt: None,
            delay_ms: None,
            message: None,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

/// 状态帧：帧头 + JSON 载荷
pub fn frame_status(notice: &SessionNotice) -> Vec<u8> {
    let mut out = Vec::with_capacity(96);
    out.push(FRAME_STATUS);
    match serde_json::to_vec(notice) {
        Ok(json) => out.extend_from_slice(&json),
        Err(e) => {
            // 兜底：至少让前端知道状态变了，别静默丢掉
            log::error!("序列化会话状态失败: {e}");
            out.extend_from_slice(br#"{"state":"reconnecting"}"#);
        }
    }
    out
}

/// 终端会话结束的原因
#[derive(Debug, Clone)]
pub enum TerminalEnd {
    /// 远端 shell 正常退出（退出码 -1 表示服务端没给退出码）
    Exited(i32),
    /// 连接异常断开
    Lost(String),
}

/// 终端输出的接收端。
///
/// 用回调而非直接依赖 Tauri 的 `Channel`，这样会话逻辑与 IPC 框架解耦，
/// 集成测试也能直接注入接收端。传入的是已加帧头的字节。
pub type OutputSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// 输出聚合：连续数据在空闲这么久后立刻冲刷（单字符回显的额外延迟上限）
const COALESCE_IDLE: Duration = Duration::from_millis(4);
/// 输出聚合：持续输出时的最大攒批窗口
const COALESCE_MAX_WAIT: Duration = Duration::from_millis(24);
/// 输出聚合：攒到这么多字节就先发，避免单帧过大
const COALESCE_MAX_BYTES: usize = 128 * 1024;

/// 读取任务向聚合任务传递的事件（顺序即到达顺序）
enum ReadEvent {
    Data(Vec<u8>),
    Exited(i32),
    Lost(String),
}

/// 终端通道的挂载结果
pub struct TerminalAttachment {
    /// 终端写半边：共享给命令层，用于写入输入与调整尺寸
    pub writer: Arc<WriteHalf>,
    /// 会话结束信号：读取循环退出时携带结束原因。
    ///
    /// 接收端被 drop（会话关闭）时返回 `Err`，据此区分
    /// 「用户关闭了会话」与「远端断开」。
    pub ended: tokio::sync::oneshot::Receiver<TerminalEnd>,
}

/// 在已建立的连接上打开 shell 通道，并启动读取循环把远端输出推给前端。
///
/// `term` 为远端 PTY 的 TERM 值（空则用 xterm-256color），
/// `encoding` 为远端 locale 的字符集（GBK/Big5 时在 Rust 侧做双向转换），
/// `startup_command` 会在登录后立即执行一次。
pub async fn attach_terminal_with(
    session: &SshSession,
    sink: OutputSink,
    ready: Option<Arc<Notify>>,
    term: &str,
    encoding: &str,
    startup_command: &str,
) -> Result<TerminalAttachment> {
    let charset = crate::textcodec::Charset::from_label(encoding);
    let term = if term.trim().is_empty() {
        "xterm-256color"
    } else {
        term.trim()
    };

    // 初始 PTY 尺寸，前端随后会发 Resize 纠正
    let (mut read_half, write_half) = ssh::open_shell(session, term, 80, 24).await?;
    log::info!("shell 通道已打开，准备启动读取循环");

    // 启动命令：等价于登录后手敲一次；空则跳过
    let startup = startup_command.trim();
    if !startup.is_empty() {
        let encoder = crate::textcodec::Encoder::new(charset);
        let mut bytes = encoder.encode(startup.as_bytes());
        bytes.push(b'\r');
        ssh::write_terminal(&write_half, &bytes).await?;
    }

    let (end_tx, end_rx) = tokio::sync::oneshot::channel();
    let mut decoder = crate::textcodec::Decoder::new(charset);
    // 读取任务 → 聚合任务：按顺序传递数据与结束事件
    let (data_tx, mut data_rx) = tokio::sync::mpsc::unbounded_channel::<ReadEvent>();

    // 读取循环：只负责从 SSH 通道取数据，尽快交出去
    tokio::spawn(async move {
        let mut total = 0usize;
        let mut first = true;
        loop {
            match ssh::read_terminal(&mut read_half).await {
                ssh::ReadStep::Data(data) => {
                    let data = decoder.push(&data);
                    if data.is_empty() {
                        continue;
                    }
                    total += data.len();
                    log::debug!("收到远端数据 {} 字节（累计 {}）", data.len(), total);
                    if first {
                        first = false;
                        if let Some(r) = &ready {
                            r.notify_one();
                        }
                    }
                    if data_tx.send(ReadEvent::Data(data)).is_err() {
                        break;
                    }
                }
                ssh::ReadStep::Exited(code) => {
                    log::info!("远端 shell 正常退出，状态码 {code}，累计接收 {total} 字节");
                    let _ = data_tx.send(ReadEvent::Exited(code));
                    break;
                }
                ssh::ReadStep::Lost(reason) => {
                    log::warn!("终端通道异常结束：{reason}，累计接收 {total} 字节");
                    let _ = data_tx.send(ReadEvent::Lost(reason));
                    break;
                }
            }
        }
    });

    // 聚合任务：把连续到达的数据包合并成一次 IPC 帧。
    //
    // - 空闲 4ms 就冲刷：单字符回显、vim 局部刷新的延迟增加不超过一帧，感知不到；
    // - 持续输出时最多攒 24ms 或 128KB 再发：`cat` 大文件时 IPC 次数下降一个量级；
    // - 结束事件先冲刷残留数据再上报，避免帧序错乱。
    tokio::spawn(async move {
        let mut pending: Vec<u8> = Vec::new();
        let mut max_deadline: Option<tokio::time::Instant> = None;

        loop {
            let event = if pending.is_empty() {
                data_rx.recv().await
            } else {
                let now = tokio::time::Instant::now();
                let deadline = max_deadline
                    .unwrap_or(now + COALESCE_MAX_WAIT)
                    .min(now + COALESCE_IDLE);
                if pending.len() >= COALESCE_MAX_BYTES || now >= deadline {
                    sink(frame_data(std::mem::take(&mut pending)));
                    max_deadline = None;
                    continue;
                }
                match tokio::time::timeout_at(deadline, data_rx.recv()).await {
                    Ok(event) => event,
                    Err(_) => {
                        sink(frame_data(std::mem::take(&mut pending)));
                        max_deadline = None;
                        continue;
                    }
                }
            };

            match event {
                // 读取任务结束（正常收尾）
                None => {
                    if !pending.is_empty() {
                        sink(frame_data(std::mem::take(&mut pending)));
                    }
                    break;
                }
                Some(ReadEvent::Data(data)) => {
                    if pending.is_empty() {
                        max_deadline = Some(tokio::time::Instant::now() + COALESCE_MAX_WAIT);
                    }
                    pending.extend_from_slice(&data);
                }
                Some(ReadEvent::Exited(code)) => {
                    if !pending.is_empty() {
                        sink(frame_data(std::mem::take(&mut pending)));
                    }
                    let msg = format!("\r\n[进程已退出，状态码 {code}]\r\n");
                    sink(frame_data(msg.into_bytes()));
                    let _ = end_tx.send(TerminalEnd::Exited(code));
                    break;
                }
                Some(ReadEvent::Lost(reason)) => {
                    if !pending.is_empty() {
                        sink(frame_data(std::mem::take(&mut pending)));
                    }
                    let _ = end_tx.send(TerminalEnd::Lost(reason));
                    break;
                }
            }
        }
    });

    Ok(TerminalAttachment {
        writer: Arc::new(write_half),
        ended: end_rx,
    })
}

/// 目录跟踪脚本
pub struct CwdTracking {
    /// 脚本内容
    pub script: String,
    /// 写到远端主目录的文件名
    pub file_name: &'static str,
    /// 加载命令，`__LSHELL_SCRIPT__` 会被替换成脚本的绝对路径
    pub load_cmd: &'static str,
}

/// 生成目录跟踪脚本。
///
/// 远端 shell 在每次显示提示符前上报当前目录，标准是 OSC 7
/// （`ESC ] 7 ; file://host/path`）。前端据此驱动 SFTP 面板跟随。
///
/// 脚本按 shell 分支生成，写到远端主目录后由交互式 shell 加载 ——
/// 这样终端里只留一行短命令，而不是一长串脚本。
///
/// shell 不支持时返回 `None`。
pub fn cwd_tracking_script(shell: &str) -> Option<CwdTracking> {
    let name = shell.rsplit('/').next().unwrap_or(shell).trim();

    // fish 的语法与 POSIX shell 不兼容，脚本要单独写一份
    if name.starts_with("fish") {
        let script = "\
function __lshell_cwd_hook
    printf '\\033]7;file://%s%s\\007' $HOSTNAME $PWD
end
functions -c fish_prompt __lshell_cwd_prompt
function fish_prompt
    __lshell_cwd_hook
    __lshell_cwd_prompt
end
__lshell_cwd_hook
";
        return Some(CwdTracking {
            script: script.to_string(),
            file_name: ".lshell_cwd.fish",
            load_cmd: "source '__LSHELL_SCRIPT__'",
        });
    }

    let supported = name.starts_with("bash")
        || name.starts_with("zsh")
        || name.starts_with("fish");
    if !supported {
        return None;
    }

    // bash 用 PROMPT_COMMAND，zsh 用 precmd_functions。
    // 这两段是 bash/zsh 专有语法，用 eval 包起来，
    // 这样脚本本身在任何 POSIX shell 里都能被解析（不报错、只是不生效）。
    let script = "\
# Lshell 目录跟踪：每次显示提示符前上报当前目录（OSC 7）
__lshell_cwd_hook() { printf '\\033]7;file://%s%s\\007' \"${HOSTNAME:-host}\" \"$PWD\"; }
if [ -n \"$ZSH_VERSION\" ]; then
    eval 'case \" ${precmd_functions[*]} \" in *__lshell_cwd_hook*) ;; *) precmd_functions+=(__lshell_cwd_hook) ;; esac'
elif [ -n \"$BASH_VERSION\" ]; then
    eval 'case \" $PROMPT_COMMAND \" in *__lshell_cwd_hook*) ;; *) PROMPT_COMMAND=\"__lshell_cwd_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}\" ;; esac'
fi
__lshell_cwd_hook
";
    Some(CwdTracking {
        script: script.to_string(),
        file_name: ".lshell_cwd.sh",
        load_cmd: ". '__LSHELL_SCRIPT__'",
    })
}

// ---------- 连接守护与自动重连 ----------

/// 重连退避序列（毫秒）。
///
/// 指数退避并封顶 30 秒。共 6 次，累计等待约 90 秒。
///
/// 退避的意义是避免服务端长时间不可达时把客户端打成「重连风暴」——
/// 比如用户拔了网线，客户端不该每 200ms 敲一次服务端。
pub const RECONNECT_BACKOFF_MS: [u64; 6] = [2000, 4000, 8000, 16000, 30000, 30000];

/// 重连所需的凭据快照。
///
/// 私钥不保存解析后的对象，只记路径与口令 —— 重连时从磁盘重新加载。
/// 这样磁盘上的私钥若被替换，重连用的是新文件而不是内存里的旧副本。
///
/// 口令在会话生命周期内驻留内存是可接受的：保险库主密钥本来就随进程
/// 常驻内存（见 `state.rs`），多留一个会话口令不改变风险量级。
#[derive(Clone)]
pub struct ReconnectSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    /// 使用本机 SSH Agent 认证
    pub use_agent: bool,
    /// 密码失败后是否改用 keyboard-interactive
    pub keyboard_interactive: bool,
    /// 出站代理
    pub proxy: Option<crate::proxy::ProxyConfig>,
    /// 单跳跳板机（重连时重新建链）
    pub jump: Option<Box<ReconnectSpec>>,
    /// 远端 PTY 的 TERM 值，空表示默认
    pub term: String,
    /// 远端字符集（utf-8 / gbk / big5）
    pub encoding: String,
    /// 登录后自动执行的命令
    pub startup_command: String,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
    pub known_hosts: Vec<ssh::KnownHostEntry>,
    /// 心跳配置：(间隔, 连续无响应次数)，None 表示用模块默认值
    pub keepalive: Option<(Duration, usize)>,
    /// 建连超时，None 表示用默认值
    pub timeout: Option<Duration>,
}

impl ReconnectSpec {
    /// 还原成连接参数。私钥加载失败时返回错误（重试无意义）。
    pub fn to_params(&self) -> Result<ssh::ConnectParams> {
        let private_key = match self.key_path.as_deref() {
            Some(path) => Some(ssh::load_private_key(path, self.key_passphrase.as_deref())?),
            None => None,
        };
        Ok(ssh::ConnectParams {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            password: self.password.clone(),
            private_key,
            use_agent: self.use_agent,
            keyboard_interactive: self.keyboard_interactive,
            proxy: self.proxy.clone(),
            jump: match &self.jump {
                Some(jump) => Some(Box::new(jump.to_params()?)),
                None => None,
            },
            known_hosts: self.known_hosts.clone(),
            keepalive: self.keepalive,
            timeout: self.timeout,
        })
    }
}

/// 一条端口转发规则，重连后按此重建监听
#[derive(Clone, Debug)]
pub struct ForwardRule {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

/// 守护任务的上下文
pub struct SupervisorContext {
    pub session_id: String,
    pub host_id: i64,
    pub alias: String,
    /// 重连用的凭据快照
    pub spec: ReconnectSpec,
    /// 重连后要恢复的自动转发规则
    pub forwards: Vec<ForwardRule>,
    /// 断线后是否自动重连（来自全局设置）
    pub auto_reconnect: bool,
}

/// 启动会话守护任务。
///
/// 守护任务负责三件事：
/// 1. 等待终端结束信号，感知连接断开；
/// 2. 断开后按指数退避自动重连；
/// 3. 重连成功后把新的写句柄、连接、SFTP 通道写回会话管理器，
///    并恢复端口转发与目录跟踪。
///
/// 状态变化通过终端通道以状态帧下发给前端，
/// 前端据此区分「正在重连」与「彻底断开」——这两者对用户的指引完全不同。
pub fn spawn_supervisor(
    ctx: SupervisorContext,
    attachment: TerminalAttachment,
    sink: OutputSink,
    sessions: SharedSessions,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        supervisor_loop(ctx, attachment, sink, sessions).await;
    })
}

/// 守护任务主循环
async fn supervisor_loop(
    ctx: SupervisorContext,
    mut attachment: TerminalAttachment,
    sink: OutputSink,
    sessions: SharedSessions,
) {
    loop {
        // 等终端结束信号
        let end = match attachment.ended.await {
            Ok(end) => end,
            Err(_) => {
                // 读取任务被丢弃 —— 会话已被主动关闭，不是故障
                log::info!("会话 {} 已关闭，守护任务退出", ctx.session_id);
                break;
            }
        };

        match end {
            TerminalEnd::Exited(code) => {
                // 远端 shell 正常退出：不是故障，不重连
                log::info!("会话 {} 的远端 shell 已退出（状态码 {code}）", ctx.session_id);
                set_state(&sessions, &ctx.session_id, SessionState::Disconnected).await;
                sink(frame_status(
                    &SessionNotice::new(NoticeState::Closed)
                        .with_message(format!("远端 shell 已退出（状态码 {code}）")),
                ));
                sink(frame_closed());
                break;
            }
            TerminalEnd::Lost(reason) => {
                log::warn!("会话 {} 连接断开：{reason}", ctx.session_id);
                // 关闭自动重连时不再先展示“正在重连”，避免误导
                if !ctx.auto_reconnect {
                    set_state(&sessions, &ctx.session_id, SessionState::Failed).await;
                    sink(frame_status(
                        &SessionNotice::new(NoticeState::Disconnected)
                            .with_message("连接已断开，自动重连已关闭"),
                    ));
                    sink(frame_closed());
                    break;
                }
                set_state(&sessions, &ctx.session_id, SessionState::Reconnecting).await;
                sink(frame_status(
                    &SessionNotice::new(NoticeState::Reconnecting)
                        .with_message(format!("连接已断开（{reason}），正在尝试重连")),
                ));
                match reconnect(&ctx, &sink, &sessions).await {
                    Some(new_attachment) => {
                        attachment = new_attachment;
                        sink(frame_status(
                            &SessionNotice::new(NoticeState::Reconnected).with_message("已重新连接"),
                        ));
                    }
                    None => {
                        set_state(&sessions, &ctx.session_id, SessionState::Failed).await;
                        sink(frame_status(
                            &SessionNotice::new(NoticeState::Disconnected)
                                .with_message("重连失败，已放弃重试"),
                        ));
                        sink(frame_closed());
                        break;
                    }
                }
            }
        }
    }
}

/// 执行重连尝试。
///
/// 成功返回新的终端挂载，失败返回 `None`（已放弃重试）。
async fn reconnect(
    ctx: &SupervisorContext,
    sink: &OutputSink,
    sessions: &SharedSessions,
) -> Option<TerminalAttachment> {
    for (i, delay_ms) in RECONNECT_BACKOFF_MS.iter().enumerate() {
        let attempt = i as u32 + 1;
        sink(frame_status(
            &SessionNotice {
                state: NoticeState::Reconnecting,
                attempt: Some(attempt),
                delay_ms: Some(*delay_ms),
                message: Some(format!(
                    "第 {attempt} 次重连将在 {} 秒后开始",
                    delay_ms / 1000
                )),
            },
        ));
        tokio::time::sleep(Duration::from_millis(*delay_ms)).await;

        let params = match ctx.spec.to_params() {
            Ok(p) => p,
            Err(e) => {
                // 私钥读不出来，重试多少次都没用
                log::error!("重连中止：无法加载私钥 — {e}");
                return None;
            }
        };

        let new_session = match ssh::connect(params).await {
            Ok(ssh::ConnectResult::Connected(s)) => s,
            Ok(ssh::ConnectResult::NeedsHostKeyTrust { .. }) => {
                // 首次连接时已经信任过主机密钥，这里再出现「首次见到」
                // 说明 known_hosts 记录被动过 —— 属于异常，直接放弃。
                log::error!("重连中止：主机密钥未被信任");
                return None;
            }
            Ok(ssh::ConnectResult::HostKeyChanged { .. }) => {
                // 指纹变更需要用户显式确认，自动重连不能替他做主
                log::error!("重连中止：主机密钥已变更，需用户确认更新");
                return None;
            }
            Err(AppError::HostKey(msg)) => {
                // 指纹变更：硬阻断，绝不静默接受
                log::error!("重连被主机密钥校验阻断：{msg}");
                return None;
            }
            Err(e) => {
                log::warn!("第 {attempt} 次重连失败：{e}");
                continue;
            }
        };

        // 打开新的 shell 通道
        let ready = Arc::new(Notify::new());
        let attachment = match attach_terminal_with(
            &new_session,
            sink.clone(),
            Some(Arc::clone(&ready)),
            &ctx.spec.term,
            &ctx.spec.encoding,
            &ctx.spec.startup_command,
        )
        .await
        {
            Ok(a) => a,
            Err(e) => {
                log::error!("第 {attempt} 次重连后打开终端失败：{e}");
                continue;
            }
        };

        // 把新句柄写回会话管理器，并恢复转发与目录跟踪
        apply_reconnected(
            sessions,
            &ctx.session_id,
            &attachment,
            &new_session,
            &ready,
            &ctx.forwards,
        )
        .await;

        log::info!("会话 {} 重连成功", ctx.session_id);
        return Some(attachment);
    }
    None
}

/// 重连成功后把新句柄写回会话管理器，并恢复端口转发与目录跟踪。
async fn apply_reconnected(
    sessions: &SharedSessions,
    session_id: &str,
    attachment: &TerminalAttachment,
    session: &SshSession,
    ready: &Arc<Notify>,
    rules: &[ForwardRule],
) {
    let conn = Arc::new(tokio::sync::Mutex::new(session.clone()));

    // 旧转发绑定在已经断开的连接上，直接停掉；
    // 同时记下重连前是否开着目录跟踪，重连后要接着用。
    let was_tracking = {
        let mut mgr = sessions.lock().await;
        let Some(s) = mgr.get_mut(session_id) else {
            log::warn!("会话 {session_id} 已不存在，放弃恢复");
            return;
        };
        for f in &s.forwards {
            f.task.abort();
        }
        s.forwards.clear();
        s.writer = Arc::clone(&attachment.writer);
        s.conn = conn.clone();
        // SFTP 子系统绑定在旧连接上，必须重建
        s.sftp = Arc::new(tokio::sync::Mutex::new(None));
        s.shell_ready = Arc::clone(ready);
        s.state = SessionState::Connected;
        let was = s.cwd_tracking;
        s.cwd_tracking = false;
        was
    };

    // 恢复端口转发
    for rule in rules {
        let result = {
            let guard = conn.lock().await;
            start_forward(
                &guard,
                rule.local_port,
                rule.remote_host.clone(),
                rule.remote_port,
            )
            .await
        };
        match result {
            Ok(listener) => {
                let mut mgr = sessions.lock().await;
                if let Some(s) = mgr.get_mut(session_id) {
                    s.forwards.push(listener);
                }
            }
            Err(e) => log::warn!(
                "恢复转发 {} → {}:{} 失败：{e}",
                rule.local_port, rule.remote_host, rule.remote_port
            ),
        }
    }

    // 恢复目录跟踪
    if was_tracking {
        if let Some(sftp) = {
            let mgr = sessions.lock().await;
            mgr.sftp(session_id).await
        } {
            if let Err(e) = inject_cwd_tracking(&conn, &sftp, &attachment.writer, ready).await {
                log::warn!("重连后恢复目录跟踪失败：{e}");
            }
        }
    }
}

/// 更新会话状态（会话可能已被关闭，找不到就忽略）
async fn set_state(sessions: &SharedSessions, session_id: &str, state: SessionState) {
    let mut mgr = sessions.lock().await;
    if let Some(s) = mgr.get_mut(session_id) {
        s.state = state;
    }
}

/// 向远端注入目录跟踪脚本。
///
/// 抽成独立函数，让「首次连接」与「重连后恢复」走同一条路径。
pub async fn inject_cwd_tracking(
    conn: &Arc<tokio::sync::Mutex<SshSession>>,
    sftp: &russh_sftp::client::SftpSession,
    writer: &Arc<WriteHalf>,
    ready: &Arc<Notify>,
) -> Result<()> {
    // 等远端吐出第一段数据（motd / 提示符）再注入，
    // 否则加载命令会插在半截输出里，位置很难看
    let _ = tokio::time::timeout(Duration::from_secs(5), ready.notified()).await;
    tokio::time::sleep(Duration::from_millis(250)).await;

    // 探测登录 shell，决定脚本写法
    let shell = {
        let session = conn.lock().await;
        ssh::detect_shell(&session).await.unwrap_or_default()
    };
    log::info!("探测到远端登录 shell: {shell}");
    let Some(tracking) = cwd_tracking_script(&shell) else {
        return Err(AppError::Invalid(format!(
            "远端 shell（{shell}）暂不支持目录跟踪"
        )));
    };

    // 脚本写到用户主目录，再让交互式 shell 加载
    let path = {
        let home = sftp
            .canonicalize(".")
            .await
            .map_err(|e| AppError::Transfer(format!("解析远端主目录失败: {e}")))?;
        log::info!("远端主目录: {home}");
        let path = format!("{}/{}", home.trim_end_matches('/'), tracking.file_name);
        // 注意：SftpSession::write 只以 WRITE 标志打开文件，
        // 目标不存在时会失败，这里显式 create 再写入。
        let mut file = sftp
            .create(&path)
            .await
            .map_err(|e| AppError::Transfer(format!("创建远端脚本失败: {e}")))?;
        file.write_all(tracking.script.as_bytes())
            .await
            .map_err(|e| AppError::Transfer(format!("写入远端脚本失败: {e}")))?;
        file.close()
            .await
            .map_err(|e| AppError::Transfer(format!("关闭远端脚本失败: {e}")))?;
        path
    };

    // 加载脚本
    let command = tracking.load_cmd.replace("__LSHELL_SCRIPT__", &path);
    log::info!("注入目录跟踪脚本: {command}");
    write_input(writer, format!("{command}\n").as_bytes()).await?;
    Ok(())
}


/// 写入用户输入
pub async fn write_input(writer: &WriteHalf, data: &[u8]) -> Result<()> {
    ssh::write_terminal(writer, data).await
}

/// 调整终端尺寸
pub async fn resize(writer: &WriteHalf, cols: u32, rows: u32) -> Result<()> {
    ssh::resize_terminal(writer, cols, rows).await
}

/// 启动本地端口转发监听
pub async fn start_forward(
    session: &SshSession,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<ForwardListener> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| AppError::Connection(format!("无法监听本地端口 {local_port}: {e}")))?;

    // 端口传 0 时由系统分配随机端口，这里必须取实际绑定的端口，
    // 否则调用方拿到的 local_port 是 0，无法连接。
    let bound_port = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(local_port);

    // Handle 不能 Clone，用 Arc<Mutex<>> 共享
    let handle = Arc::clone(&session.handle);
    // 闭包要拿走一份，这里先留一份用于返回值
    let rhost_for_return = remote_host.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let handle = Arc::clone(&handle);
            let rhost = remote_host.clone();
            tokio::spawn(async move {
                match ssh::open_forward_channel(&handle, &rhost, remote_port).await {
                    Ok(channel) => {
                        if let Err(e) = ssh::pump_forward(channel, stream).await {
                            log::debug!("转发通道结束: {e}");
                        }
                    }
                    Err(e) => log::warn!("打开转发通道失败: {e}"),
                }
            });
        }
    });

    Ok(ForwardListener {
        local_port: bound_port,
        remote_host: rhost_for_return,
        remote_port,
        task,
    })
}

/// 全局会话管理器（应用级单例）
pub type SharedSessions = Arc<tokio::sync::Mutex<SessionManager>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_tracking_script_covers_common_shells() {
        assert!(cwd_tracking_script("/bin/bash").is_some());
        assert!(cwd_tracking_script("/usr/bin/zsh").is_some());
        assert!(cwd_tracking_script("/usr/local/bin/fish").is_some());
        // 不支持的 shell 明确返回 None，由上层提示用户
        assert!(cwd_tracking_script("/bin/sh").is_none());
        assert!(cwd_tracking_script("/usr/bin/cmd.exe").is_none());
        assert!(cwd_tracking_script("").is_none());
    }

    #[test]
    fn cwd_tracking_script_emits_osc7() {
        let t = cwd_tracking_script("/bin/bash").expect("bash 应支持目录跟踪");
        // 脚本里必须带上报序列，否则前端收不到目录
        assert!(t.script.contains("\\033]7;file://%s%s\\007"));
        // 加载命令用占位符，真实路径在写入远端后替换
        assert!(t.load_cmd.contains("__LSHELL_SCRIPT__"));
        assert!(t.file_name.starts_with('.'));
    }

    #[test]
    fn fish_script_uses_fish_syntax() {
        let t = cwd_tracking_script("/usr/bin/fish").expect("fish 应支持目录跟踪");
        assert!(t.script.contains("function fish_prompt"));
        assert!(t.load_cmd.starts_with("source"));
    }

    #[test]
    fn frame_status_encodes_notice_as_json() {
        let notice = SessionNotice {
            state: NoticeState::Reconnecting,
            attempt: Some(2),
            delay_ms: Some(4000),
            message: Some("正在重连".into()),
        };
        let frame = frame_status(&notice);
        assert_eq!(frame[0], FRAME_STATUS);
        let json: serde_json::Value =
            serde_json::from_slice(&frame[1..]).expect("状态帧必须是合法 JSON");
        assert_eq!(json["state"], "reconnecting");
        assert_eq!(json["attempt"], 2);
        assert_eq!(json["delayMs"], 4000);
        assert_eq!(json["message"], "正在重连");
    }

    #[test]
    fn frame_status_omits_empty_fields() {
        let frame = frame_status(&SessionNotice::new(NoticeState::Reconnected));
        let json: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
        assert_eq!(json["state"], "reconnected");
        assert!(json.get("attempt").is_none());
        assert!(json.get("delayMs").is_none());
        assert!(json.get("message").is_none());
    }

    #[test]
    fn frame_data_keeps_payload_untouched() {
        let payload = vec![1u8, 2, 3, 255];
        let frame = frame_data(payload.clone());
        assert_eq!(frame[0], FRAME_DATA);
        assert_eq!(&frame[1..], &payload[..]);
    }

    #[test]
    fn reconnect_backoff_is_monotonic_and_capped() {
        // 退避必须单调不减，否则会出现「等得越久重试越频繁」的反常行为
        for w in RECONNECT_BACKOFF_MS.windows(2) {
            assert!(
                w[1] >= w[0],
                "退避序列不应递减: {RECONNECT_BACKOFF_MS:?}"
            );
        }
        // 单次等待封顶 30 秒
        assert!(RECONNECT_BACKOFF_MS.iter().all(|d| *d <= 30_000));
        // 总退避时间控制在 2 分钟内
        let total: u64 = RECONNECT_BACKOFF_MS.iter().sum();
        assert!(total <= 120_000, "重连总退避时间过长: {total}ms");
    }

    #[test]
    fn reconnect_spec_without_key_has_no_private_key() {
        let spec = ReconnectSpec {
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            password: Some("secret".into()),
            use_agent: false,
            keyboard_interactive: true,
            proxy: None,
            jump: None,
            term: String::new(),
            encoding: String::new(),
            startup_command: String::new(),
            key_path: None,
            key_passphrase: None,
            known_hosts: vec![],
            keepalive: None,
            timeout: None,
        };
        let params = spec.to_params().expect("应能构造连接参数");
        assert_eq!(params.host, "10.0.0.1");
        assert_eq!(params.port, 22);
        assert_eq!(params.username, "root");
        assert_eq!(params.password.as_deref(), Some("secret"));
        assert!(params.private_key.is_none());
    }

    #[test]
    fn reconnect_spec_with_missing_key_fails_fast() {
        let spec = ReconnectSpec {
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            password: None,
            use_agent: false,
            keyboard_interactive: false,
            proxy: None,
            jump: None,
            term: String::new(),
            encoding: String::new(),
            startup_command: String::new(),
            key_path: Some("Z:/不存在的私钥".into()),
            key_passphrase: None,
            known_hosts: vec![],
            keepalive: None,
            timeout: None,
        };
        // 私钥读不出来时必须直接报错，而不是让重连空转
        assert!(spec.to_params().is_err());
    }

    #[test]
    fn reconnect_spec_carries_keepalive_and_timeout() {
        let spec = ReconnectSpec {
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            password: None,
            use_agent: false,
            keyboard_interactive: false,
            proxy: None,
            jump: None,
            term: String::new(),
            encoding: String::new(),
            startup_command: String::new(),
            key_path: None,
            key_passphrase: None,
            known_hosts: vec![],
            keepalive: Some((Duration::from_secs(3), 2)),
            timeout: Some(Duration::from_secs(7)),
        };
        let params = spec.to_params().expect("应能构造连接参数");
        assert_eq!(params.keepalive, Some((Duration::from_secs(3), 2)));
        assert_eq!(params.timeout, Some(Duration::from_secs(7)));
    }
}
