//! 出站代理：HTTP CONNECT 与 SOCKS5
//!
//! 只负责在代理上打开一条到目标地址的 TCP 隧道，之后把裸流交给 SSH 握手。
//! 支持基础形态：HTTP CONNECT（可带 Basic 认证）、SOCKS5（无认证或
//! 用户名/密码认证）。不支持代理链与 UDP。

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyKind {
    Http,
    Socks5,
}

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// 经由代理连接到 `target_host:target_port`
pub async fn connect(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port)).await?;
    match proxy.kind {
        ProxyKind::Http => http_connect(&mut stream, proxy, target_host, target_port).await?,
        ProxyKind::Socks5 => socks5_connect(&mut stream, proxy, target_host, target_port).await?,
    }
    Ok(stream)
}

/// HTTP CONNECT：写请求后读到响应头结束，只接受 2xx
async fn http_connect(
    stream: &mut TcpStream,
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> io::Result<()> {
    // IPv6 目标必须写成 [addr]:port，否则冒号会被误当成端口分隔符
    let target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut req = format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: keep-alive\r\n"
    );
    if let (Some(user), Some(pass)) = (&proxy.username, &proxy.password) {
        if !user.is_empty() {
            let token = base64_encode(format!("{user}:{pass}").as_bytes());
            req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
        }
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await?;
    stream.flush().await?;

    // 逐块读到 \r\n\r\n；限制总量，避免异常代理把内存撑爆
    let mut head = Vec::with_capacity(256);
    let mut buf = [0u8; 512];
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "代理在返回 CONNECT 响应前关闭了连接",
            ));
        }
        head.extend_from_slice(&buf[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if head.len() > 16 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "代理响应头过长",
            ));
        }
    }

    let status_line = head
        .split(|b| *b == b'\n')
        .next()
        .unwrap_or_default();
    let status = String::from_utf8_lossy(status_line);
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    if !(200..300).contains(&code) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("HTTP 代理拒绝连接: {}", status.trim()),
        ));
    }
    Ok(())
}

/// SOCKS5（RFC 1928 + RFC 1929）
async fn socks5_connect(
    stream: &mut TcpStream,
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> io::Result<()> {
    let wants_auth = proxy
        .username
        .as_deref()
        .map(|u| !u.is_empty())
        .unwrap_or(false);
    // 同时提供「无认证」与「用户名/密码」，由代理选择
    let greeting: &[u8] = if wants_auth {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream.write_all(greeting).await?;
    stream.flush().await?;

    let mut resp = [0u8; 2];
    stream.read_exact(&mut resp).await?;
    if resp[0] != 0x05 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "代理不是 SOCKS5 服务",
        ));
    }
    match resp[1] {
        0x00 => {}
        0x02 if wants_auth => {
            let user = proxy.username.as_deref().unwrap_or("");
            let pass = proxy.password.as_deref().unwrap_or("");
            if user.len() > 255 || pass.len() > 255 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "SOCKS5 用户名或密码过长",
                ));
            }
            let mut auth = Vec::with_capacity(3 + user.len() + pass.len());
            auth.push(0x01);
            auth.push(user.len() as u8);
            auth.extend_from_slice(user.as_bytes());
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass.as_bytes());
            stream.write_all(&auth).await?;
            stream.flush().await?;

            let mut ar = [0u8; 2];
            stream.read_exact(&mut ar).await?;
            if ar[1] != 0x00 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "SOCKS5 认证失败",
                ));
            }
        }
        method => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("SOCKS5 代理要求不支持的认证方式: 0x{method:02x}"),
            ));
        }
    }

    // CONNECT 请求：域名交给代理解析（CONNECT 失败时 VPN/内网 DNS 也能生效）
    let mut req = Vec::with_capacity(9 + host.len());
    req.extend_from_slice(&[0x05, 0x01, 0x00]);
    if host.len() <= 255 && !host.contains(':') {
        req.push(0x03);
        req.push(host.len() as u8);
        req.extend_from_slice(host.as_bytes());
    } else if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        req.push(0x01);
        req.extend_from_slice(&ip.octets());
    } else if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        req.push(0x04);
        req.extend_from_slice(&ip.octets());
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("SOCKS5 无法表示目标地址: {host}"),
        ));
    }
    req.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&req).await?;
    stream.flush().await?;

    // 响应：VER REP RSV ATYP + BND.ADDR + BND.PORT
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "SOCKS5 响应格式错误",
        ));
    }
    if head[1] != 0x00 {
        let reason = match head[1] {
            0x01 => "代理内部错误",
            0x02 => "规则不允许",
            0x03 => "网络不可达",
            0x04 => "主机不可达",
            0x05 => "目标拒绝连接",
            0x06 => "TTL 过期",
            0x07 => "不支持的命令",
            0x08 => "不支持的地址类型",
            _ => "未知错误",
        };
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("SOCKS5 连接失败: {reason}"),
        ));
    }
    let addr_len = match head[3] {
        0x01 => 4,
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            len[0] as usize
        }
        0x04 => 16,
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("SOCKS5 响应地址类型未知: 0x{other:02x}"),
            ));
        }
    };
    let mut skip = vec![0u8; addr_len + 2];
    stream.read_exact(&mut skip).await?;
    Ok(())
}

/// 标准 Base64（RFC 4648）；只用于 Proxy-Authorization，不值得为此引依赖
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"abc"), "YWJj");
    }
}
