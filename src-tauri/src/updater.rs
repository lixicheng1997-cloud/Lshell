//! 自动更新：静态 `latest.json` + minisign 签名校验。
//!
//! 流程刻意拆成三步，避免在用户会话进行中强制退出：
//! 1. `check_update` 只查询版本，不下载；
//! 2. `download_update` 下载并校验签名，把安装包暂存在内存；
//! 3. `apply_update` 由用户点「重启以完成更新」后才启动安装器（Windows 上会退出当前进程）。
//!
//! 若不拆分，`download_and_install` 会在下载完成后立刻退出应用，
//! 与「不打断正在运行的会话」冲突。

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, Result};

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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

fn update_error(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(format!("更新失败: {e}"))
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>> {
    let updater = app.updater().map_err(update_error)?;
    let update = updater.check().await.map_err(update_error)?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.to_string()),
    }))
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<()> {
    let updater = app.updater().map_err(update_error)?;
    let update = updater
        .check()
        .await
        .map_err(update_error)?
        .ok_or_else(|| AppError::Invalid("当前已是最新版本".into()))?;

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
        .map_err(update_error)?;

    let mut slot = pending
        .0
        .lock()
        .map_err(|_| AppError::Internal("更新状态已损坏".into()))?;
    // 下载完成后才覆盖，避免旧包被半途替换
    *slot = Some((update, bytes));
    Ok(())
}

/// 用户确认「重启以完成更新」后调用。
///
/// Windows 上 `install` 会启动 NSIS 安装器并退出当前进程；
/// 其它平台需要主动重启才能进入新版本。
#[tauri::command]
pub fn apply_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<()> {
    let item = pending
        .0
        .lock()
        .map_err(|_| AppError::Internal("更新状态已损坏".into()))?
        .take();
    let Some((update, bytes)) = item else {
        return Err(AppError::Invalid("没有已下载的更新".into()));
    };

    update.install(bytes).map_err(update_error)?;
    app.restart();
}
