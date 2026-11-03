//! Lshell 核心库
//!
//! 桌面应用仅做两件事：管理主机库，以及维护到远端的 SSH 会话。

pub mod commands;
pub mod db;
pub mod dpapi;
pub mod error;
pub mod models;
pub mod session;
pub mod ssh;
pub mod state;
pub mod transfer;
pub mod vault;

use session::SessionManager;
use state::AppState;

/// 应用数据目录：%APPDATA%/Lshell
///
/// 注意：`ProjectDirs::from("com", "Lshell", "Lshell")` 在 Windows 上会生成
/// `%APPDATA%/Lshell/Lshell/data` 这种嵌套路径（qualifier 与 project 名重复）。
/// 这里直接用 `from("", "", "Lshell")`，得到干净的 `%APPDATA%/Lshell/data`。
pub fn data_dir() -> std::path::PathBuf {
    directories::ProjectDirs::from("", "", "Lshell")
        .map(|d| d.data_dir().to_path_buf())
        .unwrap_or_else(|| {
            std::env::var_os("APPDATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("Lshell")
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = db::Db::open(&data_dir().join("lshell.db")).expect("打开数据库失败");
    let state = AppState::new(db).expect("初始化保险库失败");
    let sessions = session::SharedSessions::new(tokio::sync::Mutex::new(SessionManager::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(sessions)
        .invoke_handler(tauri::generate_handler![
            commands::app_data_dir,
            commands::list_hosts,
            commands::get_host,
            commands::save_host,
            commands::delete_host,
            commands::list_tags,
            commands::upsert_tag,
            commands::delete_tag,
            commands::list_groups,
            commands::create_group,
            commands::rename_group,
            commands::delete_group,
            commands::list_forwards,
            commands::save_forward,
            commands::delete_forward,
            commands::list_known_hosts,
            commands::delete_known_host,
            commands::trust_host_key,
            commands::get_setting,
            commands::set_setting,
            commands::mask_secret,
            commands::record_command,
            commands::list_command_history,
            commands::clear_command_history,
            commands::connect_host,
            commands::disconnect_host,
            commands::terminal_write,
            commands::terminal_resize,
            commands::session_state,
            commands::session_enable_cwd_tracking,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::list_transfers,
            commands::cancel_transfer,
            commands::forward_start,
            commands::forward_stop,
            commands::forward_list,
        ])
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
