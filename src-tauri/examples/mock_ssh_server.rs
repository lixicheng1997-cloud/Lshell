//! 本地 mock SSH 服务端，用于人工验证断线检测与自动重连。
//!
//! ```bash
//! cd src-tauri && cargo run --example mock_ssh_server -- 2222
//! ```
//!
//! 然后在 Lshell 里添加一台主机：
//!
//! | 字段 | 值 |
//! |---|---|
//! | 地址 | `127.0.0.1` |
//! | 端口 | 启动时打印的端口（默认 2222） |
//! | 用户名 | `tester` |
//! | 密码 | `s3cret` |
//!
//! 首次连接会弹出主机密钥确认框，把启动时打印的指纹粘进去即可。
//!
//! **验证重连**：连接建立后按 `Ctrl+C` 结束本进程（或用防火墙断网），
//! 终端会在约 45 秒内提示「连接已断开，正在尝试重连」；
//! 重新启动本进程后会自动重连成功。
//!
//! 终端里每秒会打印一行心跳，方便肉眼确认数据通道是否还活着。

use std::sync::Arc;
use std::time::Duration;

use russh::keys::{HashAlg, PrivateKey};
use russh::server::{Auth, Config, Handler, Msg, Session};
use tokio::net::TcpListener;

/// 测试用服务端主机密钥（无口令的 ed25519 私钥，仅用于本地回环）
///
/// 这把钥匙是公开的，任何人拿到都能冒充本 mock 服务端 ——
/// 它只跑在本机回环上，不具备任何安全含义。
const TEST_HOST_KEY: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDy/GbX/vHTZFDdCHBC8uycnPw/0qHCKaaynQUY7VvXTgAAAJggCeZrIAnm
awAAAAtzc2gtZWQyNTUxOQAAACDy/GbX/vHTZFDdCHBC8uycnPw/0qHCKaaynQUY7VvXTg
AAAEAFoMnClFKrpr1ekZCqIyZbhOxkvJb6nKTFMJnlGoSpyvL8Ztf+8dNkUN0IcELy7Jyc
/D/SocIpprKdBRjtW9dOAAAAD2xzaGVsbC10ZXN0LWtleQECAwQFBg==
-----END OPENSSH PRIVATE KEY-----
";

const USER: &str = "tester";
const PASSWORD: &str = "s3cret";

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
        session.data(channel, bytes::Bytes::from_static(b"mock shell ready\r\n"))?;

        // 每秒一行心跳：让肉眼能看出数据通道是否还活着
        let session = session.handle();
        tokio::spawn(async move {
            let mut tick = 0u64;
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                tick += 1;
                let line = format!("[mock] tick {tick}\r\n");
                if session.data(channel, bytes::Bytes::from(line)).await.is_err() {
                    break;
                }
            }
        });
        Ok(())
    }

    async fn data(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // 原样回显，便于确认数据通道通畅
        session.data(channel, bytes::Bytes::copy_from_slice(data))?;
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(2222);

    let key = PrivateKey::from_openssh(TEST_HOST_KEY).expect("解析测试主机密钥失败");
    let public = key.public_key();
    let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();

    let config = Arc::new(Config {
        keys: vec![key],
        ..Default::default()
    });

    let listener = TcpListener::bind(("127.0.0.1", port)).await.expect("绑定端口失败");
    let actual = listener.local_addr().expect("读取端口失败").port();

    println!("mock SSH 服务端已启动");
    println!("  地址     127.0.0.1:{}", actual);
    println!("  用户名   {USER}");
    println!("  密码     {PASSWORD}");
    println!("  指纹     {fingerprint}");
    println!();
    println!("在 Lshell 中按上面的信息新建主机即可连接。");
    println!("按 Ctrl+C 结束本进程可模拟「服务器不可达」，");
    println!("客户端会在心跳超时后自动进入重连状态。");
    println!();
    println!("注意：本 mock 只实现了终端子系统，没有实现 SFTP，");
    println!("文件面板与拖拽上传需要连接真实服务器。");

    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            break;
        };
        println!("新连接: {peer}");
        let config = Arc::clone(&config);
        tokio::spawn(async move {
            let _ = russh::server::run_stream(config, stream, MockHandler).await;
        });
    }
}
