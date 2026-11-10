//! 文件传输的集成测试：进度、取消与并发。
//!
//! 与 `integration.rs` 一样，通过环境变量连接真实服务器。
//! **本测试会在远端 `/tmp` 下写入临时文件，并在结束时清理。**
//! 文件名带 `lshell_test_` 前缀，随手 `rm -rf /tmp/lshell_test_*` 也不会误伤别的数据。
//!
//! ```bash
//! export LSHELL_TEST_HOST=1.2.3.4 LSHELL_TEST_USER=ubuntu LSHELL_TEST_PASS='...'
//! export LSHELL_TEST_FINGERPRINT='SHA256:...'
//! cd src-tauri && cargo test --test transfer -- --nocapture
//! ```

use std::sync::Arc;
use std::time::Duration;

use lshell_lib::ssh::{self, ConnectResult};
use lshell_lib::transfer::{self, TransferDirection, TransferManager, TransferState};

/// 远端临时文件前缀
const REMOTE_PREFIX: &str = "/tmp/lshell_test_";

fn env_or(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// 连接参数；未配置凭据时返回 None（测试自动跳过）
fn test_params() -> Option<ssh::ConnectParams> {
    let host = env_or("LSHELL_TEST_HOST")?;
    let pass = env_or("LSHELL_TEST_PASS")?;
    let user = env_or("LSHELL_TEST_USER").unwrap_or_else(|| "ubuntu".into());
    let port: u16 = env_or("LSHELL_TEST_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(22);
    let fingerprint = env_or("LSHELL_TEST_FINGERPRINT").unwrap_or_default();
    let algo = env_or("LSHELL_TEST_ALGO").unwrap_or_else(|| "Ed25519".into());
    let known_hosts = if fingerprint.is_empty() {
        Vec::new()
    } else {
        vec![(host.clone(), port as i64, algo, fingerprint)]
    };

    Some(ssh::ConnectParams {
        host,
        port,
        username: user,
        password: Some(pass),
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

/// 建立连接并返回 SFTP 会话
async fn connect_sftp() -> Option<Arc<russh_sftp::client::SftpSession>> {
    let params = test_params()?;
    let session = match ssh::connect(params).await {
        Ok(ConnectResult::Connected(s)) => s,
        Ok(ConnectResult::NeedsHostKeyTrust { .. }) => {
            eprintln!("跳过：需要先信任主机密钥");
            return None;
        }
        Ok(ConnectResult::HostKeyChanged { .. }) => {
            eprintln!("跳过：主机密钥已变更，需先确认更新");
            return None;
        }
        Err(e) => {
            eprintln!("跳过：连接失败 — {e}");
            return None;
        }
    };

    let sftp = match ssh::open_sftp(&session).await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("跳过：无法打开 SFTP 子系统 — {e}");
            return None;
        }
    };
    Some(sftp)
}

/// 生成本地临时文件路径
fn local_tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("lshell_transfer_test");
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    dir.join(name)
}

/// 测试 1：上传与下载的字节内容必须完全一致，且进度准确
#[tokio::test]
async fn upload_and_download_roundtrip() {
    let Some(sftp) = connect_sftp().await else {
        return;
    };

    // 造一份有规律的内容，便于校验
    let payload: Vec<u8> = (0..(256 * 1024u32)).map(|i| (i % 251) as u8).collect();
    let local = local_tmp("roundtrip.bin");
    std::fs::write(&local, &payload).expect("写本地文件失败");

    let remote = format!("{REMOTE_PREFIX}roundtrip.bin");

    let manager = TransferManager::new();
    let task = manager.start(
        TransferDirection::Upload,
        "roundtrip.bin".into(),
        local.to_string_lossy().to_string(),
        remote.clone(),
    );

    let upload = tokio::spawn({
        let sftp = Arc::clone(&sftp);
        let task = Arc::clone(&task);
        let local = local.clone();
        let remote = remote.clone();
        async move {
            let result = transfer::run_upload(&sftp, &task, &local.to_string_lossy(), &remote).await;
            (result, task)
        }
    });

    let (_, task) = upload.await.expect("上传任务异常终止");
    manager.finish(&task, Ok(()));
    let snap = task.snapshot();
    assert_eq!(
        snap.state,
        TransferState::Completed,
        "上传应完成，实际: {:?} {:?}",
        snap.state,
        snap.error
    );
    assert_eq!(snap.total, payload.len() as u64, "总字节数应等于文件大小");
    assert_eq!(
        snap.transferred,
        payload.len() as u64,
        "已传字节数应等于文件大小"
    );

    // 远端文件内容应与本地一致
    let mut remote_file = sftp.open(&remote).await.expect("打开远端文件失败");
    let mut got = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut remote_file, &mut got)
        .await
        .expect("读取远端文件失败");
    remote_file.close().await.ok();
    assert_eq!(got.len(), payload.len(), "远端文件长度不一致");
    assert_eq!(got, payload, "远端文件内容不一致");

    // 再下载回来，逐字节比对
    let back = local_tmp("roundtrip-back.bin");
    let dtask = manager.start(
        TransferDirection::Download,
        "roundtrip.bin".into(),
        back.to_string_lossy().to_string(),
        remote.clone(),
    );
    let result = transfer::run_download(
        &sftp,
        &dtask,
        &remote,
        &back.to_string_lossy(),
    )
    .await;
    manager.finish(&dtask, result);
    let dsnap = dtask.snapshot();
    assert_eq!(dsnap.state, TransferState::Completed, "下载应完成");
    assert_eq!(dsnap.transferred, payload.len() as u64);

    let back_bytes = std::fs::read(&back).expect("读取本地回传文件失败");
    assert_eq!(back_bytes, payload, "回传内容应与原文件一致");

    // 清理
    let _ = sftp.remove_file(&remote).await;
    let _ = std::fs::remove_file(&local);
    let _ = std::fs::remove_file(&back);
    println!("✓ 上传下载内容一致，进度统计准确");
}

/// 测试 2：取消传输后应停止，且**不破坏远端已有的同名文件**
///
/// 这是最容易造成数据丢失的地方：
/// 用户传错文件想取消，结果把原来好好的同名文件删了。
/// 现在的做法是先写 `<目标名>.lshell-part`，成功后才改名，
/// 取消时只删临时文件。
#[tokio::test]
async fn cancel_upload_stops_and_preserves_existing_file() {
    let Some(sftp) = connect_sftp().await else {
        return;
    };

    let remote = format!("{REMOTE_PREFIX}cancel.bin");

    // 先放一个「原有的文件」到远端同名路径上
    let original = b"ORIGINAL-CONTENT-MUST-SURVIVE".to_vec();
    {
        let mut f = sftp.create(&remote).await.expect("创建远端文件失败");
        use tokio::io::AsyncWriteExt;
        f.write_all(&original).await.expect("写入远端失败");
        f.close().await.ok();
    }

    // 再造一个足够大的文件，保证传输期间有足够时间点取消
    let payload = vec![0xABu8; 24 * 1024 * 1024];
    let local = local_tmp("cancel.bin");
    std::fs::write(&local, &payload).expect("写本地文件失败");

    let manager = TransferManager::new();
    let task = manager.start(
        TransferDirection::Upload,
        "cancel.bin".into(),
        local.to_string_lossy().to_string(),
        remote.clone(),
    );

    let handle = tokio::spawn({
        let sftp = Arc::clone(&sftp);
        let task = Arc::clone(&task);
        let local = local.clone();
        let remote = remote.clone();
        async move {
            let result =
                transfer::run_upload(&sftp, &task, &local.to_string_lossy(), &remote).await;
            (result, task)
        }
    });

    // 等进度开始推进后再取消
    let mut cancelled_at = 0u64;
    for _ in 0..200 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let snap = task.snapshot();
        if snap.transferred > 0 && snap.transferred < snap.total {
            cancelled_at = snap.transferred;
            assert!(manager.cancel(task.id()), "应能受理取消请求");
            break;
        }
    }
    assert!(cancelled_at > 0, "传输未在预期时间内推进，无法验证取消");

    let (result, task) = handle.await.expect("上传任务异常终止");
    manager.finish(&task, result);
    let snap = task.snapshot();
    assert_eq!(
        snap.state,
        TransferState::Cancelled,
        "取消后状态应为已取消，实际: {:?}",
        snap.state
    );
    assert!(
        snap.transferred < snap.total,
        "取消后不应传完（已传 {} / 总 {}）",
        snap.transferred,
        snap.total
    );

    // 关键断言：原有的同名文件必须完好
    let mut f = sftp.open(&remote).await.expect("远端原文件应仍然存在");
    let mut got = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut f, &mut got)
        .await
        .expect("读取远端文件失败");
    f.close().await.ok();
    assert_eq!(
        got, original,
        "取消传输不应破坏远端已有的同名文件"
    );

    // 临时文件应已被清理
    let listing = sftp
        .read_dir("/tmp")
        .await
        .expect("读取 /tmp 失败");
    let leftover = listing
        .into_iter()
        .any(|e| e.file_name() == "lshell_test_cancel.bin.lshell-part");
    assert!(!leftover, "取消后不应残留临时文件");

    let _ = sftp.remove_file(&remote).await;
    let _ = std::fs::remove_file(&local);
    println!("✓ 取消后传输停止，原文件完好，临时文件已清理");
}

/// 测试 3：传输进行中仍能正常列目录
///
/// 这条测的是 SFTP 会话是否被传输独占锁死。
/// 改造前传输期间整个文件面板都会卡住。
#[tokio::test]
async fn listing_works_during_transfer() {
    let Some(sftp) = connect_sftp().await else {
        return;
    };

    let payload = vec![0x5Au8; 16 * 1024 * 1024];
    let local = local_tmp("concurrent.bin");
    std::fs::write(&local, &payload).expect("写本地文件失败");

    let remote = format!("{REMOTE_PREFIX}concurrent.bin");
    let manager = TransferManager::new();
    let task = manager.start(
        TransferDirection::Upload,
        "concurrent.bin".into(),
        local.to_string_lossy().to_string(),
        remote.clone(),
    );

    let handle = tokio::spawn({
        let sftp = Arc::clone(&sftp);
        let task = Arc::clone(&task);
        let local = local.clone();
        let remote = remote.clone();
        async move {
            let result =
                transfer::run_upload(&sftp, &task, &local.to_string_lossy(), &remote).await;
            (result, task)
        }
    });

    // 等传输真正开始
    for _ in 0..200 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        if task.snapshot().transferred > 0 {
            break;
        }
    }

    // 传输进行中列目录：必须在 5 秒内返回
    let started = std::time::Instant::now();
    let listing = tokio::time::timeout(Duration::from_secs(5), sftp.read_dir("/tmp"))
        .await
        .expect("传输期间列目录被阻塞住了")
        .expect("读取 /tmp 失败");
    let elapsed = started.elapsed();
    let count = listing.into_iter().count();
    assert!(count > 0, "/tmp 不应为空");
    println!("✓ 传输期间列目录正常，{count} 项，耗时 {elapsed:?}");

    let (result, task) = handle.await.expect("上传任务异常终止");
    manager.finish(&task, result);

    let _ = sftp.remove_file(&remote).await;
    let _ = std::fs::remove_file(&local);
}
