//! 远程文件编辑的写链路集成测试。
//!
//! 与 integration.rs（只读）不同，本文件会在远端家目录下的临时目录中
//! 创建、修改、删除文件，并在每个测试结束时递归清理，绝不触碰其他路径。
//!
//! 连接参数读取顺序：
//!   1. 环境变量 LSHELL_TEST_HOST / PORT / USER / PASS / FINGERPRINT；
//!   2. 未设置时，从本机 Lshell 应用数据库 + DPAPI 保险库读取已保存的主机。
//! 密码只在进程内存中短暂使用，不写盘、不打印日志。
//!
//! 运行：
//!   ./scripts/msvc-env.sh cargo test --manifest-path src-tauri/Cargo.toml --test editor -- --nocapture

use std::sync::Arc;

use base64::Engine;
use lshell_lib::db::Db;
use lshell_lib::dpapi;
use lshell_lib::editor::{self, EolKind, SaveResult};
use lshell_lib::ssh::{self, ConnectParams, SshSession};
use lshell_lib::vault::{self, SealedBox};
use russh_sftp::client::SftpSession;
use tokio::io::AsyncWriteExt;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// 从本机应用数据库读取指定主机的连接参数（含解密密码）。
#[cfg(windows)]
fn local_params(host_id: i64) -> Option<ConnectParams> {
    let base = directories::BaseDirs::new()?;
    let db_path = base.data_dir().join("lshell").join("data").join("lshell.db");
    if !db_path.exists() {
        return None;
    }

    let host = {
        let db = Db::open(&db_path).ok()?;
        let host = db.get_host(host_id).ok().flatten()?;
        (host.address, host.port, host.username, db.secret_ids_for_host(host_id).ok()?.0)
    };
    let (address, port, username, pw_id) = host;

    let password = if let Some(id) = pw_id {
        let db = Db::open(&db_path).ok()?;
        let (kind, nonce, ciphertext) = db.get_secret(id).ok().flatten()?;
        let (protector, wrapped) = db.vault_key().ok()??;
        if protector != dpapi::PROTECTOR_DPAPI {
            return None;
        }
        let key_bytes = dpapi::unprotect(&wrapped).ok()?;
        let key: [u8; dpapi::MASTER_KEY_LEN] = key_bytes.try_into().ok()?;
        let sealed = SealedBox { nonce, ciphertext };
        let aad = format!("lshell:secret:{kind}");
        let plain = vault::open(&key, &sealed, aad.as_bytes()).ok()?;
        Some(String::from_utf8_lossy(&plain).into_owned())
    } else {
        None
    }?;

    let known_hosts = {
        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .ok()?;
        let mut stmt = conn
            .prepare("SELECT algo, fingerprint FROM known_hosts WHERE host = ?1 AND port = ?2")
            .ok()?;
        let rows = stmt
            .query_map(rusqlite::params![address, port], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .ok()?;
        let mut out = Vec::new();
        for row in rows.flatten() {
            out.push((address.clone(), port as i64, row.0, row.1));
        }
        out
    };

    Some(ConnectParams {
        host: address,
        port: port as u16,
        username,
        password: Some(password),
        private_key: None,
        use_agent: false,
        keyboard_interactive: false,
        proxy: None,
        jump: None,
        known_hosts,
        keepalive: None,
        timeout: None,
    })
}

#[cfg(not(windows))]
fn local_params(_host_id: i64) -> Option<ConnectParams> {
    None
}

fn test_params() -> Option<ConnectParams> {
    if std::env::var("LSHELL_TEST_PASS").is_ok() {
        let host = env_or("LSHELL_TEST_HOST", "49.233.77.155");
        let port: u16 = env_or("LSHELL_TEST_PORT", "22").parse().unwrap_or(22);
        let fingerprint = env_or("LSHELL_TEST_FINGERPRINT", "");
        let algo = env_or("LSHELL_TEST_ALGO", "Ed25519");
        let known_hosts = if fingerprint.is_empty() {
            Vec::new()
        } else {
            vec![(host.clone(), port as i64, algo, fingerprint)]
        };
        return Some(ConnectParams {
            host,
            port,
            username: env_or("LSHELL_TEST_USER", "ubuntu"),
            password: Some(env_or("LSHELL_TEST_PASS", "")),
            private_key: None,
            use_agent: false,
            keyboard_interactive: false,
            proxy: None,
            jump: None,
            known_hosts,
            keepalive: None,
            timeout: None,
        });
    }
    local_params(4)
}

async fn connect_session() -> Option<SshSession> {
    let params = test_params()?;
    match ssh::connect(params).await {
        Ok(ssh::ConnectResult::Connected(s)) => Some(s),
        Ok(_) => {
            eprintln!("跳过：连接未建立（需要信任主机密钥或凭据无效）");
            None
        }
        Err(e) => {
            eprintln!("跳过：连接失败 {e}");
            None
        }
    }
}

struct RemoteDir {
    sftp: Arc<SftpSession>,
    path: String,
}

impl RemoteDir {
    async fn create(sftp: Arc<SftpSession>) -> Self {
        let home = sftp
            .canonicalize(".")
            .await
            .expect("解析家目录失败")
            .trim_end_matches('/')
            .to_string();
        let suffix: u64 = rand::random();
        let path = format!("{home}/lshell-editor-test-{suffix:016x}");
        sftp.create_dir(&path).await.expect("创建测试目录失败");
        Self { sftp, path }
    }

    fn file(&self, name: &str) -> String {
        format!("{}/{}", self.path, name)
    }

    async fn write(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.file(name);
        let mut f = self
            .sftp
            .create(&path)
            .await
            .unwrap_or_else(|e| panic!("创建 {name} 失败: {e}"));
        f.write_all(bytes).await.expect("写入测试文件失败");
        f.close().await.expect("关闭测试文件失败");
        path
    }

    async fn read(&self, path: &str) -> Vec<u8> {
        self.sftp.read(path).await.expect("读取远端文件失败")
    }
}

async fn cleanup(dir: &RemoteDir) {
    let _ = remove_tree(&dir.sftp, &dir.path).await;
}

fn remove_tree<'a>(
    sftp: &'a SftpSession,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let entries: Vec<_> = sftp
            .read_dir(path)
            .await
            .map_err(|e| e.to_string())?
            .collect();
        for entry in entries {
            let child = format!("{}/{}", path.trim_end_matches('/'), entry.file_name());
            if entry.metadata().file_type().is_dir() {
                remove_tree(sftp, &child).await?;
            } else {
                sftp.remove_file(&child).await.map_err(|e| e.to_string())?;
            }
        }
        sftp.remove_dir(path).await.map_err(|e| e.to_string())
    })
}

/// 建立连接与测试目录；不可用时返回 None 让测试跳过
async fn setup() -> Option<(SshSession, Arc<SftpSession>, RemoteDir)> {
    let session = connect_session().await?;
    let sftp = Arc::new(ssh::open_sftp(&session).await.ok()?);
    let dir = RemoteDir::create(sftp.clone()).await;
    Some((session, sftp, dir))
}

/// C1：打开文本文件 —— 内容、编码、EOL、语言、基线均正确
#[tokio::test]
async fn c1_open_text_document() {
    let Some((_session, sftp, dir)) = setup().await else {
        eprintln!("跳过：测试服务器不可用");
        return;
    };
    let src = b"server {\n  listen 80;\n}\n";
    let path = dir.write("nginx.conf", src).await;

    let meta = editor::open_document(&sftp, &path).await.expect("打开文件失败");
    assert_eq!(meta.eol, EolKind::Lf);
    assert!(!meta.bom);
    assert_eq!(meta.language, "nginx");
    assert_eq!(meta.encoding, "utf-8");
    let decoded = B64.decode(&meta.content_base64).expect("base64 解码失败");
    assert_eq!(decoded, src, "打开内容应与远端一致");
    assert_eq!(meta.baseline.size, src.len() as u64);
    println!("✓ C1 打开文本：EOL={:?} lang={} size={}", meta.eol, meta.language, meta.baseline.size);

    cleanup(&dir).await;
}

/// C2：CRLF + BOM 往返 —— 保存仅改变目标字符，EOL/BOM 不变，无备份残留
#[tokio::test]
async fn c2_crlf_bom_roundtrip() {
    let Some((_session, sftp, dir)) = setup().await else {
        eprintln!("跳过：测试服务器不可用");
        return;
    };
    let path = dir.write("crlf-bom.conf", b"\xEF\xBB\xBFkey = value\r\nsecond = line\r\n").await;
    let meta = editor::open_document(&sftp, &path).await.expect("打开文件失败");
    assert!(meta.bom, "应识别 BOM");
    assert_eq!(meta.eol, EolKind::Crlf);

    let decoded = B64.decode(&meta.content_base64).unwrap();
    let mut edited = decoded.clone();
    let pos = edited.windows(5).position(|w| w == b"value").expect("未找到待替换文本");
    edited[pos..pos + 5].copy_from_slice(b"VALUE");

    // 前端 encodeForSave 会按 meta.bom / meta.eol 还原 BOM 与 EOL
    let mut saved_bytes = Vec::new();
    if meta.bom {
        saved_bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    saved_bytes.extend_from_slice(&edited);
    let result = editor::save_document(&sftp, &path, &saved_bytes, &meta.baseline, false)
        .await
        .expect("保存失败");
    assert!(matches!(result, SaveResult::Saved { .. }), "保存应成功");
    let after = dir.read(&path).await;
    assert_eq!(after, saved_bytes, "往返后字节应完全一致");
    assert!(after.starts_with(&[0xEF, 0xBB, 0xBF]), "BOM 应保留");
    assert!(after.windows(2).any(|w| w == b"\r\n"), "CRLF 应保留");

    let entries: Vec<String> = sftp.read_dir(&dir.path).await.unwrap().map(|e| e.file_name()).collect();
    assert!(!entries.iter().any(|n| n.contains(".lshell.bak.")), "不应残留备份文件: {entries:?}");
    println!("✓ C2 CRLF+BOM 往返：字节一致、无备份残留");

    cleanup(&dir).await;
}

/// C3：保存基线冲突 —— 外部修改后保存被阻断，force 覆盖成功
#[tokio::test]
async fn c3_conflict_and_force() {
    let Some((_session, sftp, dir)) = setup().await else {
        eprintln!("跳过：测试服务器不可用");
        return;
    };
    let path = dir.write("conflict.conf", b"original\n").await;
    let meta = editor::open_document(&sftp, &path).await.expect("打开失败");

    dir.write("conflict.conf", b"changed by external process\n").await;
    let conflict = editor::save_document(&sftp, &path, b"my edit\n", &meta.baseline, false)
        .await
        .expect("冲突判定不应报错");
    match conflict {
        SaveResult::Conflict { remote_base64, .. } => {
            let remote = B64.decode(&remote_base64).unwrap();
            assert_eq!(remote, b"changed by external process\n");
        }
        _ => panic!("应判定为冲突"),
    }

    let fresh = editor::open_document(&sftp, &path).await.expect("重新打开失败");
    let saved = editor::save_document(&sftp, &path, b"my edit\n", &fresh.baseline, true)
        .await
        .expect("强制保存失败");
    assert!(matches!(saved, SaveResult::Saved { .. }));
    assert_eq!(dir.read(&path).await, b"my edit\n");
    println!("✓ C3 冲突判定与强制覆盖");

    cleanup(&dir).await;
}

/// C4：二进制与非 UTF-8 拒绝打开
#[tokio::test]
async fn c4_reject_binary_and_non_utf8() {
    let Some((_session, sftp, dir)) = setup().await else {
        eprintln!("跳过：测试服务器不可用");
        return;
    };
    let bin_path = dir.write("binary.bin", b"abc\0def").await;
    let non_utf8_path = dir.write("nonutf8.conf", &[0xff, 0xfe, 0x00, b'a']).await;

    assert!(editor::open_document(&sftp, &bin_path).await.is_err(), "二进制应被拒绝");
    assert!(editor::open_document(&sftp, &non_utf8_path).await.is_err(), "非 UTF-8 应被拒绝");
    println!("✓ C4 二进制与非 UTF-8 拒绝");

    cleanup(&dir).await;
}

/// C5：权限位保持 —— 保存后 mode 与原文件一致
#[tokio::test]
async fn c5_preserve_mode() {
    let Some((session, sftp, dir)) = setup().await else {
        eprintln!("跳过：测试服务器不可用");
        return;
    };
    let path = dir.write("mode.conf", b"mode test\n").await;
    run_exec(&session, &format!("chmod 640 {}", shell_quote(&path))).await;

    let before = sftp.metadata(&path).await.unwrap().permissions.unwrap();
    let meta = editor::open_document(&sftp, &path).await.expect("打开失败");
    let result = editor::save_document(&sftp, &path, b"mode test edited\n", &meta.baseline, false)
        .await
        .expect("保存失败");
    if let SaveResult::Saved { mode_warning, .. } = &result {
        assert!(mode_warning.is_none(), "不应有权限警告: {mode_warning:?}");
    }
    let after = sftp.metadata(&path).await.unwrap().permissions.unwrap();
    assert_eq!(after, before, "保存前后 mode 应一致（{:o} vs {:o}）", before, after);
    println!("✓ C5 权限位保持: {:o}", after);

    cleanup(&dir).await;
}

/// P5：特殊路径（空格、单引号、命令替换）—— 正确写入且无命令注入
#[tokio::test]
async fn p5_special_path() {
    let Some((session, sftp, dir)) = setup().await else {
        eprintln!("跳过：测试服务器不可用");
        return;
    };
    // 文件名不能含 `/`（会被当作路径分隔符），但空格、单引号、分号、
    // `$()` 这些 shell 元字符都保留 —— 它们才是命令注入测试的关键。
    let name = "a b'$(touch lshell_pwned_test);echo.conf";
    let path = dir.file(name);
    dir.write(name, b"special path\n").await;
    let meta = editor::open_document(&sftp, &path).await.expect("打开特殊路径失败");
    let saved = editor::save_document(&sftp, &path, b"special path edited\n", &meta.baseline, false)
        .await
        .expect("保存特殊路径失败");
    assert!(matches!(saved, SaveResult::Saved { .. }));
    assert_eq!(dir.read(&path).await, b"special path edited\n");

    // 注入检查分两处：家目录（文件名所在处）与 /tmp（原始 payload 的目标）
    let check = run_exec(
        &session,
        "test -e lshell_pwned_test -o -e /tmp/lshell_pwned_test && echo PWNED || echo SAFE",
    )
    .await;
    assert!(check.contains("SAFE"), "不应发生命令注入: {check}");
    let _ = run_exec(&session, "rm -f lshell_pwned_test /tmp/lshell_pwned_test").await;
    println!("✓ P5 特殊路径写入且无命令注入");

    cleanup(&dir).await;
}

/// C6：冲突时原文件字节保持不变
#[tokio::test]
async fn c6_conflict_keeps_original_bytes() {
    let Some((_session, sftp, dir)) = setup().await else {
        eprintln!("跳过：测试服务器不可用");
        return;
    };
    let path = dir.write("keep.conf", b"do not change\n").await;
    let meta = editor::open_document(&sftp, &path).await.expect("打开失败");
    dir.write("keep.conf", b"external edit\n").await;

    let result = editor::save_document(&sftp, &path, b"attack\n", &meta.baseline, false).await.unwrap();
    assert!(matches!(result, SaveResult::Conflict { .. }));
    assert_eq!(dir.read(&path).await, b"external edit\n", "冲突时原文件字节应保持不变");
    println!("✓ C6 冲突时原文件不变");

    cleanup(&dir).await;
}

/// 在 SSH 会话上执行一条命令，返回合并输出
async fn run_exec(session: &SshSession, command: &str) -> String {
    let channel = {
        let handle = session.handle.lock().await;
        match handle.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("跳过：无法打开 exec 通道 {e}");
                return String::new();
            }
        }
    };
    let mut channel = channel;
    if channel.exec(true, command).await.is_err() {
        return String::new();
    }
    let mut out = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => out.extend_from_slice(&data),
            russh::ChannelMsg::ExtendedData { data, .. } => out.extend_from_slice(&data),
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close { .. } => break,
            _ => {}
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
