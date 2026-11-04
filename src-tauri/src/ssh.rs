//! SSH 连接层
//!
//! 一条 TCP/SSH 连接承载多个 channel：shell（终端）、sftp（文件）、direct-tcpip（转发）。
//! 它们共享一次握手、一次主机密钥校验、一次用户认证。
//!
//! 连接状态由 Rust 侧持有，前端仅作视图。

use std::net::SocketAddr;
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

        // 查找该 (host, port) 已记录的指纹
        let stored = self
            .known
            .iter()
            .find(|(h, p, _, _)| *h == self.host && *p == self.port)
            .map(|(_, _, _, fp)| fp.clone());

        match stored {
            // 已记录且一致 —— 放行
            Some(recorded) if recorded == fingerprint => {
                *self.verdict.lock().unwrap() = HostKeyCheck::Trusted;
                Ok(true)
            }
            // 已记录但不一致 —— 硬阻断，绝不放行
            Some(recorded) => {
                *self.verdict.lock().unwrap() = HostKeyCheck::Mismatch {
                    stored_fingerprint: recorded,
                    presented_fingerprint: fingerprint,
                };
                Ok(false)
            }
            // 首次见到 —— 拒绝本次连接，由上层提示用户确认后重连
            None => {
                *self.verdict.lock().unwrap() = HostKeyCheck::Unknown { fingerprint, algo };
                Ok(false)
            }
        }
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
}

/// 把地址字段整理成 `(host, port)`。
///
/// `root@10.0.0.5`、`10.0.0.5:2222`、`[::1]:22` 这些写法会被 `getaddrinfo`
/// 当成一整个域名去查，只能得到「未知的主机」这种看不出原因的报错，
/// 所以解析前先拆开。地址里写了端口时以它为准 —— 那是用户最近一次的意图，
/// 比表单里没跟着改的端口字段更可信。
pub(crate) fn normalize_address(raw: &str, default_port: u16) -> Result<(String, u16)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("主机地址为空".into()));
    }
    if trimmed.contains('@') {
        return Err(AppError::Invalid(format!(
            "地址「{trimmed}」里不要带用户名，只填主机名，用户名写在那一栏"
        )));
    }

    let (host, inline_port) = match trimmed.strip_prefix('[') {
        // 带方括号的 IPv6：`[::1]` 或 `[::1]:2222`
        Some(body) => {
            let Some((ip, tail)) = body.split_once(']') else {
                return Err(AppError::Invalid(format!(
                    "IPv6 地址「{trimmed}」缺少右方括号"
                )));
            };
            (ip, tail.strip_prefix(':'))
        }
        // 只有「恰好一个冒号 + 纯数字后缀」才当作 host:port，
        // 否则裸 IPv6（`fe80::1`）会被从中间切碎
        None => match trimmed.rsplit_once(':') {
            Some((h, p))
                if !h.contains(':')
                    && !p.is_empty()
                    && p.bytes().all(|b| b.is_ascii_digit()) =>
            {
                (h, Some(p))
            }
            _ => (trimmed, None),
        },
    };

    let host = canonicalize_ipv4(host.trim())?;
    if host.is_empty() {
        return Err(AppError::Invalid(format!("地址「{raw}」里没有主机名")));
    }
    let port = match inline_port {
        Some(p) => parse_port(p)?,
        None => default_port,
    };
    Ok((host, port))
}

/// 把点分 IPv4 规整成标准写法，并挡下非法的段。
///
/// `100.70.05.56` 这种零填充写法（内网/Tailscale 地址常为了对齐而补零）既过不了
/// `Ipv4Addr::from_str`（Rust 严格禁止前导零），也过不了 Windows 的数字地址解析，
/// 于是整串被当成域名送去 DNS，最后报「查不到这个名字」——而用户填的明明是 IP，
/// 其他 SSH 客户端也能连。非这种形态的输入（域名、IPv6）原样交回给解析器。
///
/// 只按十进制剥前导零，不模仿老式 `inet_aton` 的八进制解释（`010` 当 8）：
/// 那种写法会让同一个地址在不同客户端连到不同机器。
fn canonicalize_ipv4(host: &str) -> Result<String> {
    let dotted_digits =
        host.contains('.') && host.bytes().all(|b| b.is_ascii_digit() || b == b'.');
    if host.is_empty() || !dotted_digits {
        return Ok(host.to_string());
    }

    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 || parts.iter().any(|p| p.is_empty() || p.len() > 3) {
        return Err(AppError::Invalid(format!(
            "地址「{host}」不是合法的 IPv4：应为点分四段、每段 1–3 位数字（当前 {} 段）",
            parts.len()
        )));
    }

    let mut octets = Vec::with_capacity(4);
    for (i, part) in parts.iter().enumerate() {
        let value: u32 = part
            .parse()
            .map_err(|_| AppError::Invalid(format!("地址「{host}」的第 {} 段无效", i + 1)))?;
        if value > 255 {
            return Err(AppError::Invalid(format!(
                "地址「{host}」的第 {} 段「{part}」不在 0–255 内",
                i + 1
            )));
        }
        octets.push(value.to_string());
    }
    Ok(octets.join("."))
}

fn parse_port(raw: &str) -> Result<u16> {
    let port: u16 = raw
        .parse()
        .map_err(|_| AppError::Invalid(format!("端口「{raw}」无效，应为 1–65535")))?;
    if port == 0 {
        return Err(AppError::Invalid("端口不能为 0".into()));
    }
    Ok(port)
}

/// `getaddrinfo` 的返回码里属于「这个名字查不出来」的那些。
///
/// Windows 是 WSA 码（11001 HOST_NOT_FOUND、11002 TRY_AGAIN、
/// 11003 NO_RECOVERY、11004 NO_DATA），类 Unix 是负的 EAI 码
/// （-2 NONAME、-3 AGAIN、-4 FAIL）。这些码在 std 里都落在
/// `ErrorKind::Uncategorized`（对应的细分 kind 还没稳定），
/// 所以只能按原始码判定。
fn is_name_lookup_failure(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(11001..=11004) | Some(-4..=-2))
}

/// 解析目标地址，并把「DNS 查不到」和「TCP 连不上」分成两种错误。
///
/// 直接把字符串主机交给 russh 的话，两者在用户眼里都是同一句
/// 「未知的主机」，而对应的处理动作完全不同（改地址 vs 查网络/VPN）。
/// 解析结果同时也交给 `client::connect`，省掉库里的第二次查询。
async fn resolve_target(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    match tokio::net::lookup_host((host, port)).await {
        Ok(addrs) => {
            let addrs: Vec<SocketAddr> = addrs.collect();
            if addrs.is_empty() {
                return Err(AppError::Connection(dns_failure_message(host, port)));
            }
            Ok(addrs)
        }
        Err(e) if is_name_lookup_failure(&e) => {
            Err(AppError::Connection(dns_failure_message(host, port)))
        }
        Err(e) => Err(AppError::Connection(format!(
            "解析主机 {host}:{port} 失败 — {e}"
        ))),
    }
}

fn dns_failure_message(host: &str, port: u16) -> String {
    format!(
        "无法解析主机「{host}」（端口 {port}）：本机 DNS 查不到这个名字。\n\
         如果这台机器只在 VPN/内网里可解析，请确认 VPN 已连接后重试；\n\
         也可以把地址直接改成它的内网 IP。"
    )
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
    // 超时提示必须带上目标地址：只说「连接超时」，用户无从判断卡在哪台机器、哪个端口
    let target = format!("{}:{}", params.host, params.port);
    match tokio::time::timeout(timeout, connect_inner(params)).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Connection(format!(
            "连接 {target} 超时（{} 秒内未完成握手）。\n\
             包发出去了但没有任何回应，通常是地址或端口不对，\n\
             或中间防火墙把包静默丢了 —— 换成本机 ssh/其他客户端连同一个地址端口对比一下。",
            timeout.as_secs()
        ))),
    }
}

/// 实际建立连接（由 [`connect`] 负责加超时）
async fn connect_inner(params: ConnectParams) -> Result<ConnectResult> {
    let (keepalive_interval, keepalive_max) = params.keepalive_settings();
    let (host, port) = normalize_address(&params.host, params.port)?;
    let target = resolve_target(&host, port).await?;

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

    let handle = client::connect(Arc::new(config), target.as_slice(), handler).await;

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
                    stored_fingerprint,
                    presented_fingerprint,
                } => {
                    return Err(AppError::HostKey(format!(
                        "主机密钥已变更！\n记录指纹: {stored_fingerprint}\n当前指纹: {presented_fingerprint}"
                    )));
                }
                HostKeyCheck::Trusted => {}
            }
            return Err(AppError::Connection(format!(
                "无法连接到 {host}:{port}（解析到 {}）— {e}",
                target
                    .iter()
                    .map(|a| a.ip().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
    };

    // 认证：按主机配置选择一种
    let auth_ok = if let Some(key) = params.private_key {
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
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await
            .map_err(|e| AppError::Auth(format!("公钥认证失败: {e}")))?;
        res.success()
    } else if let Some(password) = params.password {
        let res = handle
            .authenticate_password(params.username.clone(), password)
            .await
            .map_err(|e| AppError::Auth(format!("密码认证失败: {e}")))?;
        res.success()
    } else {
        return Err(AppError::Auth("未提供任何认证凭据".into()));
    };

    if !auth_ok {
        return Err(AppError::Auth(
            "认证被服务器拒绝，请检查用户名或凭据".into(),
        ));
    }

    Ok(ConnectResult::Connected(SshSession {
        handle: Arc::new(tokio::sync::Mutex::new(handle)),
        presented,
    }))
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
/// 探测远端登录 shell
///
/// 另开一条 exec 通道执行 `printf %s "$SHELL"`，拿到的是 /etc/passwd 里
/// 登记的登录 shell —— 交互式 shell 用的就是它。
/// 探测走独立通道，不会干扰终端会话里的输入输出。
pub async fn detect_shell(session: &SshSession) -> Result<String> {
    let channel = {
        let handle = session.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Connection(format!("无法打开探测通道: {e}")))?
    };

    channel
        .exec(true, "printf %s \"$SHELL\"")
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

    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_cleanup_splits_inline_port() {
        assert_eq!(
            normalize_address(" 10.0.0.5 ", 22).unwrap(),
            ("10.0.0.5".to_string(), 22)
        );
        assert_eq!(
            normalize_address("10.0.0.5:2222", 22).unwrap(),
            ("10.0.0.5".to_string(), 2222)
        );
        assert_eq!(
            normalize_address("example.com:22", 22).unwrap(),
            ("example.com".to_string(), 22)
        );
    }

    #[test]
    fn address_cleanup_keeps_bare_ipv6_intact() {
        assert_eq!(
            normalize_address("fe80::1", 22).unwrap(),
            ("fe80::1".to_string(), 22)
        );
        assert_eq!(
            normalize_address("[::1]:2222", 22).unwrap(),
            ("::1".to_string(), 2222)
        );
        assert_eq!(
            normalize_address("[::1]", 22).unwrap(),
            ("::1".to_string(), 22)
        );
    }

    #[test]
    fn address_cleanup_rejects_ambiguous_input() {
        // 这些输入过去只会在 DNS 那一步变成「未知的主机」，看不出真正原因
        assert!(normalize_address("", 22).is_err());
        assert!(normalize_address("   ", 22).is_err());
        assert!(normalize_address("root@10.0.0.5", 22).is_err());
        assert!(normalize_address(":2222", 22).is_err());
        assert!(normalize_address("10.0.0.5:99999", 22).is_err());
        assert!(normalize_address("[::1", 22).is_err());
    }

    #[test]
    fn dns_lookup_failures_are_told_apart_from_socket_failures() {
        // Windows: 11001 = WSAHOST_NOT_FOUND；Unix: -2 = EAI_NONAME
        assert!(is_name_lookup_failure(&std::io::Error::from_raw_os_error(11001)));
        assert!(is_name_lookup_failure(&std::io::Error::from_raw_os_error(-2)));
        // 10061 = 连接被拒绝，属于网络/端口问题，不该报「解析不到名字」
        assert!(!is_name_lookup_failure(&std::io::Error::from_raw_os_error(10061)));
    }

    #[test]
    fn address_cleanup_strips_ipv4_leading_zeros() {
        // 零填充的内网地址：过去整串会被当成域名送去 DNS，报一句看不懂的「查不到名字」
        assert_eq!(
            normalize_address("100.70.05.56", 22022).unwrap(),
            ("100.70.5.56".to_string(), 22022)
        );
        assert_eq!(
            normalize_address("100.070.05.056:22022", 22).unwrap(),
            ("100.70.5.56".to_string(), 22022)
        );
        // 已经是标准写法的不受影响；域名与 IPv6 原样交给解析器
        assert_eq!(
            normalize_address("10.0.0.5", 22).unwrap(),
            ("10.0.0.5".to_string(), 22)
        );
        assert_eq!(
            normalize_address("host.tailnet.ts.net", 22).unwrap(),
            ("host.tailnet.ts.net".to_string(), 22)
        );
    }

    #[test]
    fn address_cleanup_rejects_malformed_ipv4() {
        // 写坏的四段数字不该再流到 DNS 那一步
        assert!(normalize_address("100.70.05.256", 22).is_err());
        assert!(normalize_address("100.70.05", 22).is_err());
        assert!(normalize_address("100.70..56", 22).is_err());
        assert!(normalize_address("0300.70.0.56", 22).is_err());
        // 没有点的纯数字仍按主机名处理（内网可能有这样的短名）
        assert_eq!(
            normalize_address("192", 22).unwrap(),
            ("192".to_string(), 22)
        );
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
}
