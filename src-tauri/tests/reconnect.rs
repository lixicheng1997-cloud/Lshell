//! 断线检测与自动重连的集成测试。
//!
//! 用 russh 自带的服务器端搭一个最小 SSH 服务端，前面再套一层 TCP 代理。
//! 代理是测试的关键：它能制造「链路还在、但数据不再流动」的静默断网 ——
//! 这是最难处理的一种断线，TCP 既没有 FIN 也没有 RST，
//! 客户端只能靠应用层心跳（`keepalive@openssh.com`）判定链路已死。
//!
//! 测试不依赖任何外部服务器，`cargo test` 随时可跑。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use russh::keys::{HashAlg, PrivateKey};
use russh::server::{Auth, Config, Handler, Msg, Session};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use lshell_lib::session::{
    self, ActiveSession, ForwardRule, NoticeState, OutputSink, ReconnectSpec, SessionNotice,
    SessionState, SharedSessions, SupervisorContext,
};
use lshell_lib::ssh::{self, ConnectResult};

/// 测试用账号
const USER: &str = "tester";
const PASSWORD: &str = "s3cret";

/// 测试用服务端主机密钥（仅用于本地回环测试，无任何安全含义）
///
/// 这是一把无口令的 ed25519 私钥，OpenSSH 格式。
/// 写死在这里而不是运行时生成，是因为 russh 的密钥生成需要
/// 与 ssh-key 匹配的 rand_core 版本，实现上比较绕；
/// 而测试密钥本来就不该有任何保密要求。
const TEST_HOST_KEY: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDy/GbX/vHTZFDdCHBC8uycnPw/0qHCKaaynQUY7VvXTgAAAJggCeZrIAnm
awAAAAtzc2gtZWQyNTUxOQAAACDy/GbX/vHTZFDdCHBC8uycnPw/0qHCKaaynQUY7VvXTg
AAAEAFoMnClFKrpr1ekZCqIyZbhOxkvJb6nKTFMJnlGoSpyvL8Ztf+8dNkUN0IcELy7Jyc
/D/SocIpprKdBRjtW9dOAAAAD2xzaGVsbC10ZXN0LWtleQECAwQFBg==
-----END OPENSSH PRIVATE KEY-----
";

// ---------- 最小 SSH 服务端 ----------

struct MockHandler;

impl Handler for MockHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == USER && password == PASSWORD {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: russh::ChannelId,
        _term: &str,
        _col: u32,
        _row: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        // 模拟远端 shell 的第一段输出（motd / 提示符）
        session.data(channel, Bytes::from_static(b"READY\r\n"))?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // 原样回显，客户端能据此确认数据通道是通的
        session.data(channel, Bytes::copy_from_slice(data))?;
        Ok(())
    }
}

/// 启动 mock SSH 服务端，返回监听端口与主机密钥信息
async fn start_mock_server() -> (u16, String, String) {
    let key = PrivateKey::from_openssh(TEST_HOST_KEY).expect("解析测试主机密钥失败");
    let public = key.public_key();
    let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
    let algo = format!("{:?}", public.algorithm());

    let config = Arc::new(Config {
        keys: vec![key],
        ..Default::default()
    });

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定端口失败");
    let port = listener.local_addr().expect("读取端口失败").port();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let config = Arc::clone(&config);
            tokio::spawn(async move {
                let _ = russh::server::run_stream(config, stream, MockHandler).await;
            });
        }
    });

    (port, fingerprint, algo)
}

// ---------- 可切断的 TCP 代理 ----------

/// 代理开关：置 false 后两端数据都被丢弃，但套接字保持打开 —— 模拟静默断网。
#[derive(Clone)]
struct Link {
    up: Arc<AtomicBool>,
}

/// 启动代理：客户端连代理端口，代理再连真实服务端
async fn start_proxy(target_port: u16, link: Link) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("代理绑定端口失败");
    let port = listener.local_addr().expect("读取代理端口失败").port();

    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = listener.accept().await else {
                break;
            };
            let Ok(server) = TcpStream::connect(("127.0.0.1", target_port)).await else {
                continue;
            };
            let (mut cr, mut cw) = tokio::io::split(client);
            let (mut sr, mut sw) = tokio::io::split(server);
            let up_a = Arc::clone(&link.up);
            let up_b = Arc::clone(&link.up);

            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                loop {
                    match cr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            // 链路断开时数据被丢弃，但套接字不关闭 ——
                            // 这正是「静默断网」与「正常断开」的区别
                            if up_a.load(Ordering::SeqCst)
                                && sw.write_all(&buf[..n]).await.is_err()
                            {
                                break;
                            }
                        }
                    }
                }
            });

            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                loop {
                    match sr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if up_b.load(Ordering::SeqCst)
                                && cw.write_all(&buf[..n]).await.is_err()
                            {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });

    port
}

// ---------- 测试辅助 ----------

/// 从帧流里收集终端输出文本
fn collect_text(frame: &[u8]) -> String {
    if frame.first() == Some(&session::FRAME_DATA) {
        String::from_utf8_lossy(&frame[1..]).to_string()
    } else {
        String::new()
    }
}

/// 从帧流里解析状态通知
fn collect_notice(frame: &[u8]) -> Option<SessionNotice> {
    if frame.first() != Some(&session::FRAME_STATUS) {
        return None;
    }
    serde_json::from_slice(&frame[1..]).ok()
}

// ---------- 测试 ----------

/// 断线后守护任务应自动重连，并把状态变化通知给前端
///
/// 覆盖完整链路：静默断网 → 心跳超时判定断开 → 退避重连 → 恢复会话。
#[tokio::test]
async fn supervisor_reconnects_after_silent_link_failure() {
    let (server_port, fingerprint, algo) = start_mock_server().await;

    let link = Link {
        up: Arc::new(AtomicBool::new(true)),
    };
    let proxy_port = start_proxy(server_port, link.clone()).await;

    // 会话管理器
    let sessions: SharedSessions =
        SharedSessions::new(tokio::sync::Mutex::new(session::SessionManager::new()));

    // 心跳参数调快，测试不用等 45 秒
    let fast_keepalive = Some((Duration::from_secs(1), 3));
    let fast_timeout = Some(Duration::from_secs(4));

    let spec = ReconnectSpec {
        host: "127.0.0.1".into(),
        port: proxy_port,
        username: USER.into(),
        password: Some(PASSWORD.into()),
        key_path: None,
        key_passphrase: None,
        known_hosts: vec![(
            "127.0.0.1".into(),
            proxy_port as i64,
            algo.clone(),
            fingerprint.clone(),
        )],
        keepalive: fast_keepalive,
        timeout: fast_timeout,
    };

    let params = spec.to_params().expect("构造连接参数失败");
    let connected = match ssh::connect(params).await.expect("首次连接失败") {
        ConnectResult::Connected(s) => s,
        ConnectResult::NeedsHostKeyTrust { .. } => panic!("主机密钥应已被信任"),
    };

    // 帧收集通道
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let sink: OutputSink = Arc::new(move |frame| {
        let _ = tx.send(frame);
    });

    let attachment = session::attach_terminal(&connected, sink.clone())
        .await
        .expect("挂载终端失败");
    let writer = Arc::clone(&attachment.writer);

    {
        let mut mgr = sessions.lock().await;
        mgr.insert(
            "s1".into(),
            ActiveSession {
                host_id: 1,
                alias: "mock".into(),
                writer: Arc::clone(&writer),
                sftp: Arc::new(tokio::sync::Mutex::new(None)),
                conn: Arc::new(tokio::sync::Mutex::new(connected.clone())),
                state: SessionState::Connected,
                forwards: Vec::new(),
                cwd_tracking: false,
                shell_ready: Arc::new(tokio::sync::Notify::new()),
                supervisor: None,
            },
        );
    }

    // 启动守护任务
    let ctx = SupervisorContext {
        session_id: "s1".into(),
        host_id: 1,
        alias: "mock".into(),
        spec,
        forwards: Vec::<ForwardRule>::new(),
    };
    let _supervisor = session::spawn_supervisor(ctx, attachment, sink, sessions.clone());

    // --- 阶段一：确认初始连通 ---
    let mut saw_ready = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline && !saw_ready {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(frame)) => {
                if collect_text(&frame).contains("READY") {
                    saw_ready = true;
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(saw_ready, "未收到服务端的首段输出");

    // --- 阶段二：制造静默断网 ---
    link.up.store(false, Ordering::SeqCst);

    // 心跳超时（1s × 3）后应收到「重连中」通知
    let mut saw_reconnecting = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline && !saw_reconnecting {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(frame)) => {
                if let Some(notice) = collect_notice(&frame) {
                    println!("收到状态通知: {:?}", notice.state);
                    if notice.state == NoticeState::Reconnecting {
                        saw_reconnecting = true;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(
        saw_reconnecting,
        "静默断网后应判定为断开并进入重连；心跳参数 interval=1s × max=3，30 秒内必须触发"
    );

    // --- 阶段三：恢复链路，等待重连成功 ---
    link.up.store(true, Ordering::SeqCst);

    let mut saw_reconnected = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline && !saw_reconnected {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(frame)) => {
                if let Some(notice) = collect_notice(&frame) {
                    println!("收到状态通知: {:?}", notice.state);
                    if notice.state == NoticeState::Reconnected {
                        saw_reconnected = true;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(saw_reconnected, "链路恢复后应自动重连成功");

    // --- 阶段四：重连后的会话可用 ---
    // 写句柄必须在重连时被替换 —— 这里从会话管理器取，
    // 走的正是前端 `terminal_write` 命令的取法。
    let writer = {
        let mgr = sessions.lock().await;
        let s = mgr.get("s1").expect("会话应仍在管理器中");
        assert_eq!(s.state, SessionState::Connected, "重连后状态应为已连接");
        Arc::clone(&s.writer)
    };

    // 写入应落到新连接上：服务端会原样回显
    writer
        .data_bytes(bytes::Bytes::from_static(b"echo PING\n"))
        .await
        .expect("重连后写入失败");

    let mut saw_echo = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline && !saw_echo {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(frame)) => {
                if collect_text(&frame).contains("PING") {
                    saw_echo = true;
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(saw_echo, "重连后数据通道应恢复");
}

/// 正常退出与异常断开必须能被前端区分开
///
/// 「用户自己敲了 exit」和「链路断了」要区别对待，
/// 否则每退出一次 shell 就会莫名其妙重连一次。
#[test]
fn closed_and_reconnecting_are_distinct_states() {
    let closed = session::SessionNotice::new(NoticeState::Closed);
    let frame = session::frame_status(&closed);
    let notice: SessionNotice = serde_json::from_slice(&frame[1..]).expect("状态帧应可解析");
    assert_eq!(notice.state, NoticeState::Closed);

    assert_ne!(NoticeState::Closed, NoticeState::Reconnecting);
    assert_ne!(NoticeState::Reconnected, NoticeState::Disconnected);
}
