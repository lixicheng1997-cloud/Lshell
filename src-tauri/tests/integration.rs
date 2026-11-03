//! 针对真实服务器的集成测试。
//!
//! 仅执行只读命令，绝不修改或删除远端任何文件。
//!
//! 连接参数从环境变量读取，避免把凭据写进代码库：
//!   LSHELL_TEST_HOST / LSHELL_TEST_PORT / LSHELL_TEST_USER / LSHELL_TEST_PASS
//!   LSHELL_TEST_FINGERPRINT（已信任的主机密钥指纹）
//!
//! 运行：LSHELL_TEST_PASS=xxx cargo test --test integration -- --nocapture

use std::time::Duration;

use lshell_lib::ssh::{self, ConnectParams};
use russh::keys::HashAlg;
use tokio::io::AsyncReadExt;

/// 测试用的只读命令清单
const READONLY_COMMANDS: &[&str] = &[
    "echo LSHELL_TEST_MARKER",
    "whoami",
    "pwd",
    "uname -a",
];

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// 读取测试连接参数；缺少凭据时跳过测试
fn test_params() -> Option<ConnectParams> {
    let pass = std::env::var("LSHELL_TEST_PASS").ok()?;
    let host = env_or("LSHELL_TEST_HOST", "49.233.77.155");
    let port: u16 = env_or("LSHELL_TEST_PORT", "22").parse().unwrap_or(22);
    let user = env_or("LSHELL_TEST_USER", "ubuntu");
    let fingerprint = env_or("LSHELL_TEST_FINGERPRINT", "");

    // 已知主机密钥：把指纹登记进去，连接时才会被放行
    let known_hosts = if fingerprint.is_empty() {
        Vec::new()
    } else {
        vec![(host.clone(), port as i64, "ssh-ed25519".to_string(), fingerprint)]
    };

    Some(ConnectParams {
        host,
        port,
        username: user,
        password: Some(pass),
        private_key: None,
        known_hosts,
        keepalive: None,
        timeout: None,
    })
}

/// 建立连接并返回会话
async fn connect_session() -> Option<ssh::SshSession> {
    let params = test_params()?;
    match ssh::connect(params).await {
        Ok(ssh::ConnectResult::Connected(s)) => Some(s),
        Ok(ssh::ConnectResult::NeedsHostKeyTrust { fingerprint, algo }) => {
            eprintln!("跳过：需要先信任主机密钥 {fingerprint} ({algo})");
            None
        }
        Err(e) => {
            eprintln!("连接失败: {e}");
            None
        }
    }
}

/// 在会话上执行一条命令并收集输出
async fn run_command(
    session: &ssh::SshSession,
    command: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let channel = {
        let handle = session.handle.lock().await;
        handle.channel_open_session().await?
    };

    channel.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[]).await?;
    channel.exec(true, command).await?;

    let mut output = Vec::new();
    let mut channel = channel;

    while let Some(msg) = channel.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => output.extend_from_slice(&data),
            russh::ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
            russh::ChannelMsg::ExitStatus { .. } => break,
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close { .. } => break,
            _ => {}
        }
    }

    Ok(String::from_utf8_lossy(&output).into_owned())
}

/// 测试 1：密码认证 + 主机密钥校验
#[tokio::test]
async fn test_password_auth_and_host_key() {
    let Some(params) = test_params() else {
        eprintln!("跳过：未设置 LSHELL_TEST_PASS");
        return;
    };

    let host = params.host.clone();
    let port = params.port;
    match ssh::connect(params).await {
        Ok(ssh::ConnectResult::Connected(session)) => {
            println!("✓ 密码认证成功，连上 {host}:{port}");
            // 校验通过意味着 presented 已被填充
            let presented = session.presented.lock().unwrap().clone();
            if let Some((fp, algo)) = presented {
                println!("  主机密钥 {algo} {fp}");
            }
        }
        Ok(ssh::ConnectResult::NeedsHostKeyTrust { fingerprint, algo }) => {
            // 未登记指纹时应要求用户确认，而不是直接放行
            println!("✓ 首次连接按预期要求确认: {fingerprint} ({algo})");
        }
        Err(e) => {
            panic!("连接失败: {e}");
        }
    }
}

/// 测试 2：执行只读命令
#[tokio::test]
async fn test_readonly_commands() {
    let Some(session) = connect_session().await else {
        eprintln!("跳过：无法建立连接");
        return;
    };

    for cmd in READONLY_COMMANDS {
        let out = run_command(&session, cmd).await.expect("命令执行失败");
        let trimmed = out.trim();
        println!("✓ `{cmd}` => {}", trimmed.lines().next().unwrap_or(""));
        assert!(!trimmed.is_empty(), "命令 `{cmd}` 返回了空输出");
    }

    // 验证标记确实回传
    let out = run_command(&session, "echo LSHELL_TEST_MARKER").await.unwrap();
    assert!(
        out.contains("LSHELL_TEST_MARKER"),
        "标记未出现在输出中: {out}"
    );
}

/// 测试 3：交互式 shell（PTY）——验证读写分离与终端数据流
#[tokio::test]
async fn test_interactive_shell() {
    let Some(session) = connect_session().await else {
        eprintln!("跳过：无法建立连接");
        return;
    };

    let (mut read_half, write_half) =
        ssh::open_shell(&session, "xterm-256color", 80, 24).await.expect("打开 shell 失败");

    // 写入一条命令
    write_half
        .data_bytes(bytes::Bytes::from_static(b"echo INTERACTIVE_OK\n"))
        .await
        .expect("写入失败");

    // 读取输出，直到看到标记
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut collected = String::new();

    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(3), read_half.wait()).await {
            Ok(Some(russh::ChannelMsg::Data { data })) => {
                collected.push_str(&String::from_utf8_lossy(&data));
                if collected.contains("INTERACTIVE_OK") {
                    break;
                }
            }
            Ok(Some(_)) => continue,
            Ok(None) => break,
            Err(_) => continue,
        }
    }

    assert!(
        collected.contains("INTERACTIVE_OK"),
        "交互式 shell 未收到预期输出。已收到: {collected}"
    );
    println!("✓ 交互式 shell 正常，收到标记");
}

/// 测试 4：SFTP —— 复用同一条 SSH 连接打开 SFTP 子系统
#[tokio::test]
async fn test_sftp_listing() {
    let Some(session) = connect_session().await else {
        eprintln!("跳过：无法建立连接");
        return;
    };

    let sftp = ssh::open_sftp(&session).await.expect("打开 SFTP 失败");

    let entries = sftp.read_dir(".").await.expect("读取目录失败");
    let names: Vec<String> = entries.map(|e| e.file_name()).collect();
    println!("✓ SFTP 列出 {} 项: {:?}", names.len(), &names[..names.len().min(8)]);

    assert!(!names.is_empty(), "家目录不应为空");

    // 只读：读取当前路径的规范化形式
    let canonical = sftp.canonicalize(".").await.expect("canonicalize 失败");
    println!("  当前路径: {canonical:?}");
}

/// 测试 5：端口转发 —— 复用同一条连接开 direct-tcpip 通道
#[tokio::test]
async fn test_port_forwarding() {
    let Some(session) = connect_session().await else {
        eprintln!("跳过：无法建立连接");
        return;
    };

    // 只做通道层验证：连到服务器自身的 SSH 端口（只建立 TCP，不发送数据）
    let channel = ssh::open_forward_channel(&session.handle, "127.0.0.1", 22)
        .await
        .expect("打开转发通道失败");
    println!("✓ direct-tcpip 通道建立成功");
    drop(channel);
}

/// 测试 7：主机密钥指纹不匹配时必须硬阻断
///
/// 用一个故意错误的指纹，验证连接被拒绝而不是被放行。
#[tokio::test]
async fn test_host_key_mismatch_is_blocked() {
    let Some(mut params) = test_params() else {
        eprintln!("跳过：未设置 LSHELL_TEST_PASS");
        return;
    };

    // 伪造一个错误的已登记指纹
    params.known_hosts = vec![(
        params.host.clone(),
        params.port as i64,
        "ssh-ed25519".to_string(),
        "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
    )];

    match ssh::connect(params).await {
        Ok(ssh::ConnectResult::Connected(_)) => {
            panic!("指纹不匹配时不应连接成功")
        }
        // 首次见到（指纹未登记）不是安全事件，交由用户确认
        Ok(ssh::ConnectResult::NeedsHostKeyTrust { .. }) => {
            panic!("伪造指纹不应导致「首次见到」，说明校验逻辑有误")
        }
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.contains("已变更"),
                "应报「主机密钥已变更」，实际: {msg}"
            );
            // 硬阻断时不得泄露认证信息
            assert!(!msg.contains("密码"), "错误信息不应包含凭据: {msg}");
            println!("✓ 指纹不匹配被正确阻断: {msg}");
        }
    }
}
/// 测试 8：完整终端数据通道 —— 连接 → 开 shell → 写入 → 收到输出
///
/// 这是 UI 实际走的路径：Rust 侧持有连接，前端通过通道收发字节。
#[tokio::test]
async fn test_terminal_channel_roundtrip() {
    let Some(params) = test_params() else {
        eprintln!("跳过：未设置 LSHELL_TEST_PASS");
        return;
    };

    let session = match ssh::connect(params).await.unwrap() {
        ssh::ConnectResult::Connected(s) => s,
        ssh::ConnectResult::NeedsHostKeyTrust { .. } => {
            eprintln!("跳过：需要先信任主机密钥");
            return;
        }
    };

    // 建立一个模拟前端的接收端
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let sink: lshell_lib::session::OutputSink = std::sync::Arc::new(move |frame| {
        let _ = tx.send(frame);
    });

    let attachment = lshell_lib::session::attach_terminal(&session, sink)
        .await
        .expect("attach_terminal 失败");
    let writer = attachment.writer;

    // 前端写入
    writer
        .data_bytes(bytes::Bytes::from_static(b"echo CHANNEL_MARKER_123\n"))
        .await
        .expect("写入失败");

    // Rust 侧应收到远端输出
    let mut received = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);

    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
            Ok(Some(frame)) => {
                // 帧头：0x00 = 数据，0x01 = 会话结束
                match frame.first() {
                    Some(&lshell_lib::session::FRAME_DATA) => {
                        received.push_str(&String::from_utf8_lossy(&frame[1..]));
                    }
                    Some(&lshell_lib::session::FRAME_CLOSED) => break,
                    _ => {}
                }
                if received.contains("CHANNEL_MARKER_123") {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }

    assert!(
        received.contains("CHANNEL_MARKER_123"),
        "通道未收到预期输出。已收到: {received}"
    );
    println!("✓ 终端通道收发正常，收到 {} 字节", received.len());

    // 尺寸变更不应报错
    writer
        .window_change(120, 40, 0, 0)
        .await
        .expect("调整尺寸失败");
    println!("✓ 终端尺寸调整成功");
}

/// 测试 9：SFTP 列目录 + 只读元信息
///
/// 复用与终端同一条连接，验证 channel 复用方案在真实服务器上成立。
#[tokio::test]
async fn test_sftp_metadata_details() {
    let Some(params) = test_params() else {
        eprintln!("跳过：未设置 LSHELL_TEST_PASS");
        return;
    };

    let session = match ssh::connect(params).await.unwrap() {
        ssh::ConnectResult::Connected(s) => s,
        _ => {
            eprintln!("跳过：需要先信任主机密钥");
            return;
        }
    };

    let sftp = ssh::open_sftp(&session).await.expect("打开 SFTP 失败");

    // 列出家目录，校验每一项都有正确的元信息
    let entries: Vec<_> = sftp.read_dir(".").await.expect("读取目录失败").collect();
    assert!(!entries.is_empty(), "家目录不应为空");

    for entry in &entries {
        let name = entry.file_name();
        assert!(!name.is_empty(), "文件名不应为空");
        // metadata 直接来自 list 请求，无需额外 stat
        let meta = entry.metadata();
        assert!(
            meta.size.is_some() || meta.file_type().is_dir(),
            "文件 {name} 缺少大小或类型信息"
        );
    }

    // 只读校验：读取一个已存在文件的元信息
    let sample = entries
        .iter()
        .find(|e| !e.file_type().is_dir())
        .expect("家目录应至少有一个文件");

    let meta = sftp
        .metadata(&sample.path())
        .await
        .expect("读取文件元信息失败");
    println!(
        "✓ 文件 {} 大小 {} 字节",
        sample.file_name(),
        meta.size.unwrap_or(0)
    );

    // 目录本身
    let canonical = sftp.canonicalize(".").await.expect("canonicalize 失败");
    assert!(
        canonical.starts_with('/'),
        "当前路径应为绝对路径，实际: {canonical}"
    );
    let count = entries.len();
    println!("✓ 当前路径 {canonical}，共 {count} 项");
}

/// 测试 10：端口转发 —— 走完整的 start_forward 流程并验证数据可达
#[tokio::test]
async fn test_forward_end_to_end() {
    let Some(params) = test_params() else {
        eprintln!("跳过：未设置 LSHELL_TEST_PASS");
        return;
    };

    let session = match ssh::connect(params).await.unwrap() {
        ssh::ConnectResult::Connected(s) => s,
        _ => {
            eprintln!("跳过：需要先信任主机密钥");
            return;
        }
    };

    // 在本地监听一个端口，转发到服务器自身的 22 端口
    let listener = lshell_lib::session::start_forward(&session, 0, "127.0.0.1".into(), 22)
        .await
        .expect("启动转发失败");

    let local_port = listener.local_port;
    println!("✓ 本地端口 {local_port} → 127.0.0.1:22");

    // 连本地端口，应当能收到远端 SSH 服务的握手横幅
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::net::TcpStream::connect(("127.0.0.1", local_port)),
    )
    .await
    .expect("连接本地转发端口超时")
    .expect("连接本地转发端口失败");

    let mut buf = [0u8; 64];
    let n = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        stream.read(&mut buf),
    )
    .await
    .expect("读取转发数据超时")
    .expect("读取转发数据失败");

    let banner = String::from_utf8_lossy(&buf[..n]);
    assert!(
        banner.starts_with("SSH-"),
        "转发数据应为 SSH 握手横幅，实际: {banner:?}"
    );
    println!("✓ 转发成功，收到横幅: {}", banner.trim());
}

/// 测试 6：主机密钥指纹格式与 russh 内置实现一致
#[test]
fn test_fingerprint_format() {
    // 验证 fingerprint() 输出格式为 OpenSSH 标准的 SHA256:base64
    // 用公钥解析器（decode_openssh 只能解私钥）
    let key = russh::keys::PublicKey::from_openssh(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM3sU7ULbnuZy19s8So72EpDPXqqND0jh5cF4S93R+T2",
    )
    .expect("解析公钥失败");

    let fp = key.fingerprint(HashAlg::Sha256).to_string();
    println!("✓ 指纹: {fp}");
    assert!(fp.starts_with("SHA256:"), "指纹格式应为 SHA256: 前缀，实际 {fp}");
    assert_eq!(
        fp,
        "SHA256:nXyutBpsfwa8oRtST+scEMoqs/qxMvqIWDUwIMH/Abs",
        "指纹与 ssh-keyscan 采集结果不一致"
    );
}
