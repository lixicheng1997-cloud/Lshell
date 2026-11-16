//! SSH 连接层
//!
//! 一条 TCP/SSH 连接承载多个 channel：shell（终端）、sftp（文件）、direct-tcpip（转发）。
//! 它们共享一次握手、一次主机密钥校验、一次用户认证。
//!
//! 连接状态由 Rust 侧持有，前端仅作视图。

use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, Result};
use crate::models::HostKeyCheck;

/// 已记录的 (host, port, algo, fingerprint)
pub type KnownHostEntry = (String, i64, String, String);

/// 客户端事件处理器。
///
/// 主机密钥校验在 `check_server_key` 中完成，返回 false 即拒绝连接。
/// 校验结论写入 `verdict`，供上层决定是提示用户还是直接阻断。
pub struct ClientHandler {
    host: String,
    port: i64,
    known: Arc<Vec<KnownHostEntry>>,
    /// 本次连接看到的指纹 (fingerprint, algo)
    pub presented: Arc<Mutex<Option<(String, String)>>>,
    /// 校验结论
    pub verdict: Arc<Mutex<HostKeyCheck>>,
}

impl ClientHandler {
    pub fn new(host: String, port: i64, known: Vec<KnownHostEntry>) -> Self {
        ClientHandler {
            host,
            port,
            known: Arc::new(known),
            presented: Arc::new(Mutex::new(None)),
            verdict: Arc::new(Mutex::new(HostKeyCheck::Trusted)),
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let pubkey = server_public_key.public_key();
        let fingerprint = pubkey.fingerprint(HashAlg::Sha256).to_string();
        let algo = format!("{:?}", pubkey.algorithm());

        *self.presented.lock().unwrap() = Some((fingerprint.clone(), algo.clone()));

        let verdict = evaluate_known_host(&self.known, &self.host, self.port, &algo, &fingerprint);
        let trusted = matches!(verdict, HostKeyCheck::Trusted);
        *self.verdict.lock().unwrap() = verdict;
        Ok(trusted)
    }
}

/// 按 (host, port, algo) 校验本次连接看到的主机密钥。
///
/// 与 OpenSSH 一致：同一主机可以因不同密钥类型各存一条记录，
/// 协商到哪一种就只校验哪一种 —— 否则服务器新增或轮换密钥类型时
/// 会被误判成「指纹变更」，反过来也会让真正的篡改藏进其它算法条目里。
fn evaluate_known_host(
    known: &[KnownHostEntry],
    host: &str,
    port: i64,
    algo: &str,
    fingerprint: &str,
) -> HostKeyCheck {
    let stored = known
        .iter()
        .find(|(h, p, a, _)| h == host && *p == port && a == algo)
        .map(|(_, _, _, fp)| fp.clone());

    // 是否记录过该主机的其它密钥类型（用于区分「新增算法」与「首次连接」）
    let known_other_algo = known
        .iter()
        .any(|(h, p, a, _)| h == host && *p == port && a != algo);

    match stored {
        // 同算法且一致 —— 放行
        Some(recorded) if recorded == fingerprint => HostKeyCheck::Trusted,
        // 同算法但不一致 —— 阻断本次连接，由上层提供「确认更新」
        Some(recorded) => HostKeyCheck::Mismatch {
            algo: algo.to_string(),
            stored_fingerprint: recorded,
            presented_fingerprint: fingerprint.to_string(),
        },
        // 该算法首次见到：首次连接或服务器新增密钥类型，都需要用户确认
        None => HostKeyCheck::Unknown {
            fingerprint: fingerprint.to_string(),
            algo: algo.to_string(),
            known_other_algo,
        },
    }
}

/// 计算主机密钥指纹（OpenSSH 格式 `SHA256:base64`）
pub fn fingerprint_of(key: &PublicKeyOrCertificate) -> String {
    key.public_key().fingerprint(HashAlg::Sha256).to_string()
}

/// 已建立的 SSH 会话。
///
/// `Handle` 内部持有 `UnboundedReceiver`，不是 `Sync`，也无法 `Clone`。
/// 因此用 `Arc<Mutex<>>` 共享给各个需要它的任务。
///
/// 两个字段都是 `Arc`，因此整个会话可以廉价克隆 —— 重连时需要
/// 同时把连接交给守护任务和会话管理器。
#[derive(Clone)]
pub struct SshSession {
    pub handle: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
    /// 本次连接见到的 (指纹, 算法)
    pub presented: Arc<Mutex<Option<(String, String)>>>,
    /// 经跳板机连接时，跳板机自身的会话。
    ///
    /// 目标连接跑在跳板机的一条 direct-tcpip 通道上，通道随跳板机会话存活；
    /// 这里持有它是为了不让它在中途被 drop —— 一旦释放，目标连接会立刻断开。
    pub jump: Option<Box<SshSession>>,
}

/// 建连超时默认值：TCP 连接 + SSH 握手 + 认证的总时限。
///
/// OpenSSH 的 `ConnectTimeout` 默认是「不超时」，但对桌面客户端来说
/// 「点连接后界面永远转圈」比「明确报错」糟糕得多。
pub const DEFAULT_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 连接参数
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    /// 私钥（已在 Rust 侧解密）
    pub private_key: Option<russh::keys::PrivateKey>,
    /// 使用本机 SSH Agent（OpenSSH agent 或 Pageant）里的密钥认证
    pub use_agent: bool,
    /// 密码认证被拒绝/未提供时，是否改用 keyboard-interactive（同样用密码作答）
    pub keyboard_interactive: bool,
    /// 出站代理；与 `jump` 互斥，`jump` 优先
    pub proxy: Option<crate::proxy::ProxyConfig>,
    /// 单跳跳板机：先连它，再从它开一条 direct-tcpip 到目标。
    /// 跳板机的字段里 `jump` 必须为空（只支持单跳）。
    pub jump: Option<Box<ConnectParams>>,
    pub known_hosts: Vec<KnownHostEntry>,
    /// 心跳配置：(间隔, 连续无响应次数)。
    ///
    /// 对应 OpenSSH 的 `ClientAliveInterval` / `ClientAliveCountMax`。
    /// None 表示使用模块默认值。
    pub keepalive: Option<(std::time::Duration, usize)>,
    /// 建连超时。None 表示使用 [`DEFAULT_CONNECT_TIMEOUT`]。
    pub timeout: Option<std::time::Duration>,
}

impl ConnectParams {
    /// 心跳参数：优先用调用方指定的，否则用模块默认值
    fn keepalive_settings(&self) -> (std::time::Duration, usize) {
        self.keepalive
            .unwrap_or((KEEPALIVE_INTERVAL, KEEPALIVE_MAX))
    }

    /// 建连超时
    fn connect_timeout(&self) -> std::time::Duration {
        self.timeout.unwrap_or(DEFAULT_CONNECT_TIMEOUT)
    }
}

/// 心跳间隔：多久没收到服务端数据就发一个 `keepalive@openssh.com` 请求。
///
/// 该请求是 OpenSSH 的标准扩展，绝大多数服务器（sshd、dropbear、wolfSSH）
/// 都会回应，因此可以安全地当作「链路是否还活着」的探针。
pub const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// 连续多少次心跳无响应就判定连接已死。
///
/// 15s × 3 = 45 秒内察觉不到服务端，就认为链路断了。
/// 这个时间窗要大于一次典型的网络抖动（丢包、基站切换、VPN 重连），
/// 否则会把「网络抖一下」误判成「连接断了」，白白触发一次重连。
pub const KEEPALIVE_MAX: usize = 3;

/// 建立 SSH 连接并完成认证。
///
/// 连接结果
pub enum ConnectResult {
    /// 连接成功
    Connected(SshSession),
    /// 首次见到该主机，需要用户确认指纹后再重连
    NeedsHostKeyTrust { fingerprint: String, algo: String },
    /// 同一算法下指纹变更，需要用户「确认更新」后再重连
    HostKeyChanged {
        fingerprint: String,
        algo: String,
        stored_fingerprint: String,
    },
}

/// 把地址字段整理成 `(host, port)`。
///
/// 只处理两种会被系统解析器误读的写法：点分 IPv4 里的前导零、以及误填在地址里的
/// 端口。认不出来的形态原样交回，交给系统解析器 —— 报错文案与改动前完全一致。
pub(crate) fn normalize_address(raw: &str, default_port: u16) -> (String, u16) {
    let trimmed = raw.trim();
    let (body, inline) = split_inline_port(trimmed);
    let body = body.trim();
    if body.is_empty() {
        return (trimmed.to_string(), default_port);
    }
    (canonicalize_ipv4(body), inline.unwrap_or(default_port))
}

/// 从地址里拆出内嵌的端口：`10.0.0.5:2222`、`[::1]:2222` 认，裸 IPv6 不拆。
///
/// 地址写了端口时以它为准 —— 那是用户最近一次的意图，比没跟着改的端口字段更可信。
fn split_inline_port(address: &str) -> (&str, Option<u16>) {
    if let Some(inner) = address.strip_prefix('[') {
        return match inner.split_once(']') {
            Some((ip, tail)) => (ip, tail.strip_prefix(':').and_then(parse_inline_port)),
            // 括号没闭合：原样交给解析器，别猜
            None => (address, None),
        };
    }
    match address.rsplit_once(':') {
        // 只有「恰好一个冒号」才当作 host:port，否则 `fe80::1` 会被从中间切碎
        Some((host, tail)) if !host.contains(':') => match parse_inline_port(tail) {
            Some(port) => (host, Some(port)),
            None => (address, None),
        },
        _ => (address, None),
    }
}

fn parse_inline_port(tail: &str) -> Option<u16> {
    tail.parse::<u16>().ok().filter(|port| *port > 0)
}

/// 点分 IPv4 的前导零按十进制剥掉：`100.70.05.56` → `100.70.5.56`。
///
/// 内网/Tailscale 地址常为了对齐而补零，但这种写法既过不了 `Ipv4Addr::from_str`
/// （Rust 严格禁止前导零），也过不了 Windows 的数字地址解析，于是整串被当成域名
/// 送去 DNS，报出一句和真实原因无关的「未知的主机」——其他 SSH 客户端接受它，
/// 所以只在 Lshell 里连不上。不模仿老式 `inet_aton` 的八进制解释（`010` 当 8）：
/// 那会让同一个地址在不同客户端连到不同机器。
///
/// 不是合法四段（`100.70.05`、`100.70.05.256`）时原样返回，不做二次猜测。
fn canonicalize_ipv4(host: &str) -> String {
    let dotted_digits =
        host.contains('.') && host.bytes().all(|b| b.is_ascii_digit() || b == b'.');
    if !dotted_digits {
        return host.to_string();
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 || parts.iter().any(|part| part.len() > 3) {
        return host.to_string();
    }
    let mut octets = Vec::with_capacity(4);
    for part in parts {
        let Ok(value) = part.parse::<u32>() else {
            return host.to_string();
        };
        if value > 255 {
            return host.to_string();
        }
        octets.push(value.to_string());
    }
    octets.join(".")
}

/// 主机密钥校验通过 `ClientHandler` 完成。
///
/// 返回 `Err` 的情况：
/// - 指纹与已记录的不一致（必须阻断，绝不放行）
/// - 网络/协议层错误
///
/// 首次见到某台主机时返回 `NeedsHostKeyTrust`，由调用方提示用户确认后
/// 写入 known_hosts 再重连。
pub async fn connect(params: ConnectParams) -> Result<ConnectResult> {
    let timeout = params.connect_timeout();
    match tokio::time::timeout(timeout, connect_inner(params)).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Connection(format!(
            "连接超时（{} 秒内未完成握手）",
            timeout.as_secs()
        ))),
    }
}

/// 实际建立连接（由 [`connect`] 负责加超时）
async fn connect_inner(params: ConnectParams) -> Result<ConnectResult> {
    let (keepalive_interval, keepalive_max) = params.keepalive_settings();
    let (host, port) = normalize_address(&params.host, params.port);

    let config = client::Config {
        // 不用 inactivity_timeout：它的语义是「多久没收到任何数据就掐断连接」，
        // 会误杀正在挂机的交互式终端（挂机 5 分钟必掉线）。
        // 存活判定交给下面的 keepalive —— 心跳有应答就说明链路还活着。
        inactivity_timeout: None,
        // keepalive@openssh.com 全局请求：服务端连续不回应，
        // 累计到 keepalive_max 次后 russh 关闭连接，终端读取循环随即感知到断开。
        keepalive_interval: Some(keepalive_interval),
        keepalive_max,
        ..Default::default()
    };

    let handler = ClientHandler::new(host.clone(), port as i64, params.known_hosts.clone());

    // handler 会被移交给 connect，这里先克隆共享状态，
    // 以便在握手失败时读取校验结论。
    let verdict = Arc::clone(&handler.verdict);
    let presented = Arc::clone(&handler.presented);

    // 先建立传输链路：直连、经代理、或经跳板机的 direct-tcpip 通道。
    // 三种形态最终都收敛成一个 AsyncRead + AsyncWrite 的流。
    let (stream, jump) = open_transport(&params, &host, port).await?;

    let handle = client::connect_stream(Arc::new(config), stream, handler).await;

    let mut handle = match handle {
        Ok(h) => h,
        Err(e) => {
            // 握手阶段失败：检查是否为主机密钥问题
            let verdict = verdict.lock().unwrap().clone();
            match verdict {
                HostKeyCheck::Unknown { .. } => {
                    // 首次见到 —— 返回待确认的指纹，让上层提示用户
                    let (fingerprint, algo) = presented.lock().unwrap().clone().unwrap_or_else(
                        || ("未知".to_string(), "未知".to_string()),
                    );
                    return Ok(ConnectResult::NeedsHostKeyTrust { fingerprint, algo });
                }
                HostKeyCheck::Mismatch {
                    algo,
                    stored_fingerprint,
                    presented_fingerprint,
                } => {
                    // 指纹变更不直接报错：交给用户确认后替换记录并重连
                    return Ok(ConnectResult::HostKeyChanged {
                        fingerprint: presented_fingerprint,
                        algo,
                        stored_fingerprint,
                    });
                }
                HostKeyCheck::Trusted => {}
            }
            return Err(AppError::Connection(format!(
                "无法连接到 {host}:{port} — {e}"
            )));
        }
    };

    // 认证：按主机配置选择一种
    let auth_ok = authenticate(&mut handle, &params).await?;

    if !auth_ok {
        return Err(AppError::Auth(
            "认证被服务器拒绝，请检查用户名或凭据".into(),
        ));
    }

    Ok(ConnectResult::Connected(SshSession {
        handle: Arc::new(tokio::sync::Mutex::new(handle)),
        presented,
        jump,
    }))
}

/// 底层传输链路。三种来源统一装箱，交给 [`client::connect_stream`]。
trait Transport: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Transport for T {}
type BoxedTransport = Box<dyn Transport>;

/// 建立到目标的传输，返回 `(流, 需要一并保活的跳板机会话)`
async fn open_transport(
    params: &ConnectParams,
    host: &str,
    port: u16,
) -> Result<(BoxedTransport, Option<Box<SshSession>>)> {
    // 1) 跳板机：先连跳板机，再从它开一条到目标的 TCP 通道
    if let Some(jump_params) = &params.jump {
        // 递归调用必须装箱，否则 async fn 的 future 尺寸无法确定
        let jump_session = match Box::pin(connect_inner(ConnectParams {
            host: jump_params.host.clone(),
            port: jump_params.port,
            username: jump_params.username.clone(),
            password: jump_params.password.clone(),
            private_key: jump_params.private_key.clone(),
            use_agent: jump_params.use_agent,
            keyboard_interactive: jump_params.keyboard_interactive,
            proxy: jump_params.proxy.clone(),
            // 只支持单跳：跳板机自身不再挂跳板
            jump: None,
            known_hosts: jump_params.known_hosts.clone(),
            keepalive: jump_params.keepalive,
            timeout: jump_params.timeout,
        }))
        .await?
        {
            ConnectResult::Connected(s) => s,
            ConnectResult::NeedsHostKeyTrust { fingerprint, .. } => {
                return Err(AppError::HostKey(format!(
                    "跳板机 {}:{} 的主机密钥尚未确认（指纹 {fingerprint}），请先单独连接一次该跳板机完成确认",
                    jump_params.host, jump_params.port
                )));
            }
            ConnectResult::HostKeyChanged {
                stored_fingerprint,
                fingerprint,
                ..
            } => {
                return Err(AppError::HostKey(format!(
                    "跳板机 {}:{} 的主机密钥已变更！\n记录指纹: {stored_fingerprint}\n当前指纹: {fingerprint}\n请先单独连接该跳板机并确认更新后再使用跳板",
                    jump_params.host, jump_params.port
                )));
            }
        };

        let channel = {
            let guard = jump_session.handle.lock().await;
            guard
                .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1".to_string(), 0)
                .await
                .map_err(|e| {
                    AppError::Connection(format!(
                        "跳板机 {} 无法转发到 {host}:{port} — {e}",
                        jump_params.host
                    ))
                })?
        };
        return Ok((
            Box::new(channel.into_stream()),
            Some(Box::new(jump_session)),
        ));
    }

    // 2) 代理：HTTP CONNECT / SOCKS5
    if let Some(proxy) = &params.proxy {
        let stream = crate::proxy::connect(proxy, host, port).await.map_err(|e| {
            AppError::Connection(format!("经代理 {}:{} 连接 {host}:{port} 失败 — {e}", proxy.host, proxy.port))
        })?;
        let _ = stream.set_nodelay(true);
        return Ok((Box::new(stream), None));
    }

    // 3) 直连
    let stream = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|e| AppError::Connection(format!("无法连接到 {host}:{port} — {e}")))?;
    let _ = stream.set_nodelay(true);
    Ok((Box::new(stream), None))
}

/// 按主机配置执行认证
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    params: &ConnectParams,
) -> Result<bool> {
    if let Some(key) = params.private_key.as_ref() {
        // best_supported_rsa_hash 返回 Result<Option<Option<HashAlg>>, _>
        // 内层 Option 表示「服务端是否声明支持 RSA 签名算法」
        let hash_alg = handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten();
        let res = handle
            .authenticate_publickey(
                params.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key.clone()), hash_alg),
            )
            .await
            .map_err(|e| AppError::Auth(format!("公钥认证失败: {e}")))?;
        return Ok(res.success());
    }

    if params.use_agent {
        return authenticate_with_agent(handle, &params.username).await;
    }

    if let Some(password) = params.password.as_ref() {
        let res = handle
            .authenticate_password(params.username.clone(), password.clone())
            .await
            .map_err(|e| AppError::Auth(format!("密码认证失败: {e}")))?;
        if res.success() {
            return Ok(true);
        }
        // 不少服务器（尤其加固后的 sshd）只开 keyboard-interactive，
        // 把密码当作对每个提示的回答再试一次
        if params.keyboard_interactive {
            return authenticate_keyboard_interactive(handle, &params.username, password).await;
        }
        return Ok(false);
    }

    Err(AppError::Auth("未提供任何认证凭据".into()))
}

/// 用本机 SSH Agent 认证：依次尝试 agent 里的每把密钥
async fn authenticate_with_agent(
    handle: &mut Handle<ClientHandler>,
    username: &str,
) -> Result<bool> {
    use russh::keys::agent::client::AgentClient;

    // Windows 上优先 OpenSSH 自带的 agent 管道，其次 Pageant
    let mut agent = match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(a) => a.dynamic(),
        Err(pipe_err) => match AgentClient::connect_pageant().await {
            Ok(a) => a.dynamic(),
            Err(pageant_err) => {
                return Err(AppError::Auth(format!(
                    "无法连接本机 SSH Agent（OpenSSH: {pipe_err}；Pageant: {pageant_err}）"
                )));
            }
        },
    };

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::Auth(format!("SSH Agent 读取密钥失败: {e}")))?;
    if identities.is_empty() {
        return Err(AppError::Auth(
            "SSH Agent 中没有可用的密钥，请先执行 ssh-add".into(),
        ));
    }

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    for identity in identities {
        let public_key = identity.public_key().into_owned();
        match handle
            .authenticate_publickey_with(
                username.to_string(),
                public_key,
                hash_alg,
                &mut agent,
            )
            .await
        {
            Ok(res) if res.success() => return Ok(true),
            // 服务端不接受这把密钥，换下一把
            Ok(_) => continue,
            Err(e) => {
                log::debug!("SSH Agent 密钥签名失败，尝试下一把: {e}");
                continue;
            }
        }
    }
    Ok(false)
}

/// keyboard-interactive：把密码作为对每个提示的回答
async fn authenticate_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    password: &str,
) -> Result<bool> {
    use russh::client::KeyboardInteractiveAuthResponse as Kbi;

    let mut response = handle
        .authenticate_keyboard_interactive_start(username.to_string(), None)
        .await
        .map_err(|e| AppError::Auth(format!("keyboard-interactive 认证失败: {e}")))?;
    loop {
        match response {
            Kbi::Success => return Ok(true),
            Kbi::Failure { .. } => return Ok(false),
            Kbi::InfoRequest { prompts, .. } => {
                let answers = vec![password.to_string(); prompts.len()];
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| AppError::Auth(format!("keyboard-interactive 认证失败: {e}")))?;
            }
        }
    }
}

/// 终端通道的读写两半。
///
/// 读半边需要 `&mut self`（wait），独占放在读取任务中；
/// 写半边的方法都是 `&self`，用 `Arc` 共享给命令层。
pub type ReadHalf = ChannelReadHalf;
pub type WriteHalf = ChannelWriteHalf<client::Msg>;

/// 在已有连接上打开 shell 通道并请求 PTY，随后拆分为读写两半
pub async fn open_shell(
    session: &SshSession,
    term: &str,
    cols: u32,
    rows: u32,
) -> Result<(ReadHalf, WriteHalf)> {
    let channel = {
        let handle = session.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Connection(format!("无法打开终端通道: {e}")))?
    };

    channel
        .request_pty(true, term, cols, rows, 0, 0, &[])
        .await
        .map_err(|e| AppError::Connection(format!("请求 PTY 失败: {e}")))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::Connection(format!("启动远程 shell 失败: {e}")))?;

    Ok(channel.split())
}

/// 一次读取的结果。
///
/// 区分「远端正常退出」与「连接异常断开」是自动重连的前提：
/// 前者说明用户自己敲了 `exit`，重连没有意义；后者才是需要重连的情况。
#[derive(Debug, Clone)]
pub enum ReadStep {
    /// 远端输出数据
    Data(Vec<u8>),
    /// 远端 shell 正常退出，携带退出码（-1 表示服务端没给退出码）
    Exited(i32),
    /// 连接异常断开
    Lost(String),
}

/// 从读半边读取一条消息。
///
/// 与终端输出无关的消息（窗口调整、请求成功/失败等）会被跳过，
/// 一直读到有意义的消息为止。
pub async fn read_terminal(channel: &mut ReadHalf) -> ReadStep {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => return ReadStep::Data(data.to_vec()),
            Some(ChannelMsg::ExtendedData { data, .. }) => return ReadStep::Data(data.to_vec()),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                return ReadStep::Exited(exit_status as i32)
            }
            // 远端关闭了写方向但没给退出码：仍属于正常退出
            Some(ChannelMsg::Eof) => return ReadStep::Exited(-1),
            // 通道被关闭
            Some(ChannelMsg::Close) => return ReadStep::Lost("通道被关闭".into()),
            // 通道被销毁 —— 连接层断开（网络中断、keepalive 超时等）
            None => return ReadStep::Lost("链路中断".into()),
            Some(_) => continue,
        }
    }
}

/// 向终端写入用户输入
pub async fn write_terminal(channel: &WriteHalf, data: &[u8]) -> Result<()> {
    channel
        .data_bytes(bytes::Bytes::copy_from_slice(data))
        .await
        .map_err(|e| AppError::Connection(format!("发送终端数据失败: {e}")))
}

/// 通知远端终端尺寸变化
pub async fn resize_terminal(channel: &WriteHalf, cols: u32, rows: u32) -> Result<()> {
    channel
        .window_change(cols, rows, 0, 0)
        .await
        .map_err(|e| AppError::Connection(format!("调整终端尺寸失败: {e}")))
}

/// 在已有连接上打开 SFTP 子系统
pub async fn open_sftp(session: &SshSession) -> Result<russh_sftp::client::SftpSession> {
    let channel = {
        let handle = session.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Transfer(format!("无法打开 SFTP 通道: {e}")))?
    };

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Transfer(format!("请求 SFTP 子系统失败: {e}")))?;

    russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::Transfer(format!("初始化 SFTP 会话失败: {e}")))
}

/// 在已有连接上打开端口转发通道（direct-tcpip）
pub async fn open_forward_channel(
    handle: &Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
    remote_host: &str,
    remote_port: u16,
) -> Result<russh::Channel<client::Msg>> {
    let handle = handle.lock().await;
    handle
        .channel_open_direct_tcpip(
            remote_host,
            remote_port as u32,
            "127.0.0.1",
            0,
        )
        .await
        .map_err(|e| AppError::Connection(format!("打开转发通道失败: {e}")))
}

/// 把转发通道接到本地 TCP 连接上，双向搬运数据
pub async fn pump_forward(
    channel: russh::Channel<client::Msg>,
    local: tokio::net::TcpStream,
) -> Result<()> {
    let (mut cr, mut cw) = tokio::io::split(channel.into_stream());
    let (mut lr, mut lw) = tokio::io::split(local);

    let to_remote = async {
        let mut buf = vec![0u8; 8192];
        loop {
            let n = lr.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            cw.write_all(&buf[..n]).await?;
            cw.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    };

    let to_local = async {
        let mut buf = vec![0u8; 8192];
        loop {
            let n = cr.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            lw.write_all(&buf[..n]).await?;
            lw.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    };

    tokio::try_join!(to_remote, to_local)
        .map_err(|e| AppError::Connection(format!("转发数据搬运失败: {e}")))?;
    Ok(())
}

/// 从磁盘加载私钥
pub fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<russh::keys::PrivateKey> {
    russh::keys::load_secret_key(path, passphrase)
        .map_err(|e| AppError::Auth(format!("加载私钥失败: {e}")))
}
/// 在已有连接上另开一条 exec 通道执行命令，收集 stdout。
///
/// 走独立通道，不会干扰终端会话里的输入输出。
pub async fn exec_capture(session: &SshSession, command: &str) -> Result<String> {
    let channel = {
        let handle = session.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Connection(format!("无法打开探测通道: {e}")))?
    };

    channel
        .exec(true, command)
        .await
        .map_err(|e| AppError::Connection(format!("无法执行探测命令: {e}")))?;

    let mut out = String::new();
    let mut channel = channel;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.push_str(&String::from_utf8_lossy(&data)),
            ChannelMsg::ExitStatus { .. } => break,
            ChannelMsg::Eof => break,
            ChannelMsg::Close { .. } => break,
            _ => {}
        }
    }

    Ok(out)
}

/// 探测远端登录 shell
///
/// 另开一条 exec 通道执行 `printf %s "$SHELL"`，拿到的是 /etc/passwd 里
/// 登记的登录 shell —— 交互式 shell 用的就是它。
pub async fn detect_shell(session: &SshSession) -> Result<String> {
    let out = exec_capture(session, "printf %s \"$SHELL\"").await?;
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_cleanup_strips_ipv4_leading_zeros() {
        // 零填充的内网/Tailscale 地址：过去整串会被当成域名送去 DNS
        assert_eq!(
            normalize_address("100.70.05.56", 22022),
            ("100.70.5.56".to_string(), 22022)
        );
        assert_eq!(
            normalize_address("100.070.05.056:22022", 22),
            ("100.70.5.56".to_string(), 22022)
        );
        // 已经是标准写法的不受影响
        assert_eq!(
            normalize_address("10.0.0.5", 22),
            ("10.0.0.5".to_string(), 22)
        );
    }

    #[test]
    fn address_cleanup_splits_inline_port() {
        assert_eq!(
            normalize_address(" 10.0.0.5 ", 22),
            ("10.0.0.5".to_string(), 22)
        );
        assert_eq!(
            normalize_address("10.0.0.5:2222", 22),
            ("10.0.0.5".to_string(), 2222)
        );
    }

    #[test]
    fn address_cleanup_leaves_unrecognized_input_alone() {
        // 域名、IPv6、认不出的形态都原样交回，报错文案与改动前一致
        assert_eq!(
            normalize_address("host.tailnet.ts.net", 22),
            ("host.tailnet.ts.net".to_string(), 22)
        );
        assert_eq!(normalize_address("fe80::1", 22), ("fe80::1".to_string(), 22));
        assert_eq!(
            normalize_address("[::1]:2222", 22),
            ("::1".to_string(), 2222)
        );
        assert_eq!(normalize_address("[::1]", 22), ("::1".to_string(), 22));
        assert_eq!(
            normalize_address("root@10.0.0.5", 22),
            ("root@10.0.0.5".to_string(), 22)
        );
        // 没有点的纯数字仍按主机名处理（内网可能有这样的短名）
        assert_eq!(normalize_address("192", 22), ("192".to_string(), 22));
        // 写坏的四段数字不做二次猜测
        assert_eq!(
            normalize_address("100.70.05.256", 22),
            ("100.70.05.256".to_string(), 22)
        );
        assert_eq!(
            normalize_address("100.70.05", 22),
            ("100.70.05".to_string(), 22)
        );
        assert_eq!(
            normalize_address("100.70..56", 22),
            ("100.70..56".to_string(), 22)
        );
        assert_eq!(
            normalize_address("0300.70.0.56", 22),
            ("0300.70.0.56".to_string(), 22)
        );
        // 端口后缀认不出来时沿用端口字段的值
        assert_eq!(
            normalize_address("10.0.0.5:99999", 22),
            ("10.0.0.5:99999".to_string(), 22)
        );
        assert_eq!(
            normalize_address("10.0.0.5:0", 22),
            ("10.0.0.5:0".to_string(), 22)
        );
        assert_eq!(normalize_address("", 22), ("".to_string(), 22));
    }

    #[test]
    fn keepalive_window_survives_network_jitter() {
        // 判定窗口至少 30 秒：网络抖一下（丢包、基站切换、VPN 重连）
        // 不应该被误判成「连接断了」，否则会白白触发一次重连。
        let window = KEEPALIVE_INTERVAL * KEEPALIVE_MAX as u32;
        assert!(
            window >= std::time::Duration::from_secs(30),
            "心跳判定窗口过短: {window:?}"
        );
        // 但也不能太长，否则用户要等很久才知道连接已断
        assert!(
            window <= std::time::Duration::from_secs(90),
            "心跳判定窗口过长: {window:?}"
        );
    }

    #[test]
    fn keepalive_interval_is_not_too_frequent() {
        // 10 秒一次心跳对每条连接来说流量可以忽略
        assert!(KEEPALIVE_INTERVAL >= std::time::Duration::from_secs(10));
    }

    // ---------- 主机指纹按算法匹配 ----------

    fn entry(host: &str, port: i64, algo: &str, fp: &str) -> KnownHostEntry {
        (host.to_string(), port, algo.to_string(), fp.to_string())
    }

    #[test]
    fn host_key_matches_by_algorithm() {
        let known = vec![
            entry("srv", 22, "Ed25519", "SHA256:ed"),
            entry("srv", 22, "Rsa", "SHA256:rsa"),
        ];

        // 每种算法各自比对：RSA 记录不会覆盖 Ed25519 记录
        assert!(matches!(
            evaluate_known_host(&known, "srv", 22, "Ed25519", "SHA256:ed"),
            HostKeyCheck::Trusted
        ));
        assert!(matches!(
            evaluate_known_host(&known, "srv", 22, "Rsa", "SHA256:rsa"),
            HostKeyCheck::Trusted
        ));
    }

    #[test]
    fn host_key_change_is_only_detected_within_same_algorithm() {
        let known = vec![entry("srv", 22, "Ed25519", "SHA256:old")];

        // 同算法换了指纹 → 变更
        match evaluate_known_host(&known, "srv", 22, "Ed25519", "SHA256:new") {
            HostKeyCheck::Mismatch {
                algo,
                stored_fingerprint,
                presented_fingerprint,
            } => {
                assert_eq!(algo, "Ed25519");
                assert_eq!(stored_fingerprint, "SHA256:old");
                assert_eq!(presented_fingerprint, "SHA256:new");
            }
            other => panic!("应判定为指纹变更，实际: {other:?}"),
        }

        // 不同算法 → 不是变更，而是「该算法待确认」
        match evaluate_known_host(&known, "srv", 22, "Rsa", "SHA256:rsa") {
            HostKeyCheck::Unknown {
                known_other_algo, ..
            } => assert!(known_other_algo, "应标记该主机已有其它算法记录"),
            other => panic!("不同算法不应判为指纹变更，实际: {other:?}"),
        }
    }

    #[test]
    fn unknown_host_has_no_other_algorithm() {
        // 端口不同或主机不同都不能借用已有记录
        let known = vec![entry("srv", 22, "Ed25519", "SHA256:ed")];
        match evaluate_known_host(&known, "srv", 2222, "Ed25519", "SHA256:ed") {
            HostKeyCheck::Unknown {
                known_other_algo, ..
            } => assert!(!known_other_algo, "其它端口不应复用记录"),
            other => panic!("应为首次见到，实际: {other:?}"),
        }
    }
}
