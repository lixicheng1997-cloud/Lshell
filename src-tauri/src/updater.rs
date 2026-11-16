//! 自动更新：静态 `latest.json` + minisign 签名校验。
//!
//! 流程刻意拆成三步，避免在用户会话进行中强制退出：
//! 1. `check_update` 只查询版本，不下载；
//! 2. `download_update` 下载并校验签名，把安装包暂存在内存；
//! 3. `apply_update` 由用户点「重启以完成更新」后才启动安装器（Windows 上会退出当前进程）。
//!
//! 若不拆分，`download_and_install` 会在下载完成后立刻退出应用，
//! 与「不打断正在运行的会话」冲突。
//!
//! 错误统一转成 [`UpdateFailure`]：前端按 `kind` 给出不同的可读文案和处理建议，
//! 而不是所有失败都显示同一句「更新失败」。

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

/// 自动更新功能的唯一开关。
///
/// 关闭时：
/// - 托盘菜单不出现「检查更新」；
/// - 前端不渲染设置页的更新区块，启动后也不发任何更新请求；
/// - 命令本身仍然注册，方便以后打开开关直接复用。
///
/// 以后要恢复，只把这里改成 `true` 即可（前端会通过 [`update_enabled`] 读到同一个值）。
pub const FEATURE_ENABLED: bool = false;

/// 供前端查询功能是否开启，避免前后端各维护一份开关。
#[tauri::command]
pub fn update_enabled() -> bool {
    FEATURE_ENABLED
}

/// 更新相关的失败。`kind` 是稳定的分类键，`message` 是面向排查的技术细节。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateFailure {
    pub kind: &'static str,
    pub message: String,
}

impl UpdateFailure {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// 把插件错误映射成可区分的失败类型。
///
/// 插件的错误信息本身比较笼统，这里按变体拆开：
/// - `ReleaseNotFound` 只会出现在「所有端点都返回非 2xx」时；
/// - `Serialization` 是返回了 200 但 JSON 结构不对；
/// - `Reqwest` 再按超时 / 解码 / TLS / 连接细分；
/// - minisign 相关变体统一归为签名失败。
fn classify(error: UpdaterError) -> UpdateFailure {
    let raw = error.to_string();
    match &error {
        UpdaterError::ReleaseNotFound => UpdateFailure::new(
            "http",
            "更新源没有返回成功的响应（非 2xx），或响应体不是版本清单",
        ),
        UpdaterError::Serialization(e) => {
            UpdateFailure::new("json", format!("版本清单 JSON 无法解析：{e}"))
        }
        UpdaterError::TargetNotFound(target) => {
            UpdateFailure::new("target", format!("版本清单里没有 {target} 条目"))
        }
        UpdaterError::TargetsNotFound(targets) => {
            UpdateFailure::new("target", format!("版本清单里没有可用的平台条目：{targets:?}"))
        }
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => {
            UpdateFailure::new("signature", format!("安装包签名校验失败：{raw}"))
        }
        UpdaterError::InsecureTransportProtocol => UpdateFailure::new(
            "insecure",
            "当前构建只允许 https 更新端点，配置的地址不是 https",
        ),
        UpdaterError::EmptyEndpoints => {
            UpdateFailure::new("insecure", "没有配置任何更新端点")
        }
        UpdaterError::Reqwest(e) => {
            let text = e.to_string();
            let lower = text.to_lowercase();
            if e.is_timeout() {
                UpdateFailure::new("timeout", format!("请求更新源超时：{text}"))
            } else if e.is_decode() {
                UpdateFailure::new("json", format!("响应内容无法解码：{text}"))
            } else if lower.contains("certificate")
                || lower.contains("handshake")
                || lower.contains("tls")
                || lower.contains("ssl")
            {
                UpdateFailure::new("blocked", format!("TLS 握手或证书校验失败：{text}"))
            } else if e.is_connect() || e.is_request() {
                UpdateFailure::new("unreachable", format!("无法连接更新源：{text}"))
            } else {
                UpdateFailure::new("network", format!("网络请求失败：{text}"))
            }
        }
        _ => UpdateFailure::new("unknown", raw),
    }
}

/// 已下载待安装的更新包：安装包本身与对应的 Update（用于再次校验签名）
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<(Update, Vec<u8>)>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// 更新说明（可能为空）
    pub notes: String,
    /// 发布日期（可能为空）
    pub date: Option<String>,
    /// 安装包大小（字节）。HEAD 拿不到时为 None，不影响检查结果。
    pub size: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

/// 读取安装包大小。只做一次短超时的 HEAD，失败就返回 None。
async fn fetch_size(url: &str) -> Option<u64> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let response = client.head(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.content_length()
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
) -> std::result::Result<Option<UpdateInfo>, UpdateFailure> {
    let updater = app.updater().map_err(classify)?;
    let update = updater.check().await.map_err(classify)?;
    let Some(update) = update else {
        return Ok(None);
    };

    // check() 内部已经为请求安装过 rustls 的默认 provider，这里可以安全复用
    let size = fetch_size(update.download_url.as_str()).await;

    Ok(Some(UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        date: update.date.map(|d| d.to_string()),
        size,
    }))
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> std::result::Result<(), UpdateFailure> {
    let updater = app.updater().map_err(classify)?;
    let update = updater
        .check()
        .await
        .map_err(classify)?
        .ok_or_else(|| UpdateFailure::new("uptodate", "当前已是最新版本"))?;

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| ((downloaded.saturating_mul(100) / t) as u8).min(100));
                let _ = progress_app.emit(
                    "update://progress",
                    DownloadProgress {
                        downloaded,
                        total,
                        percent,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(classify)?;

    let mut slot = pending
        .0
        .lock()
        .map_err(|_| UpdateFailure::new("unknown", "更新状态已损坏"))?;
    // 下载完成后才覆盖，避免旧包被半途替换
    *slot = Some((update, bytes));
    Ok(())
}

/// 用户确认「重启以完成更新」后调用。
///
/// Windows 上 `install` 会启动 NSIS 安装器并退出当前进程；
/// 其它平台需要主动重启才能进入新版本。
#[tauri::command]
pub fn apply_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> std::result::Result<(), UpdateFailure> {
    let item = pending
        .0
        .lock()
        .map_err(|_| UpdateFailure::new("unknown", "更新状态已损坏"))?
        .take();
    let Some((update, bytes)) = item else {
        return Err(UpdateFailure::new("unknown", "没有已下载的更新"));
    };

    update.install(bytes).map_err(classify)?;
    app.restart();
}
