//! Lshell 核心库
//!
//! 桌面应用仅做两件事：管理主机库，以及维护到远端的 SSH 会话。

pub mod clipboard;
pub mod commands;
pub mod db;
pub mod dpapi;
pub mod error;
pub mod importer;
pub mod models;
pub mod proxy;
pub mod redact;
pub mod session;
pub mod ssh;
pub mod state;
pub mod textcodec;
pub mod transfer;
pub mod updater;
pub mod vault;

use session::SessionManager;
use state::AppState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// 把主窗口带到前台：单实例重入、点击托盘图标都会走这里
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

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
        // 单实例插件必须最先注册：第二个进程会被它直接结束，并唤出已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(sessions)
        .manage(updater::PendingUpdate::default())
        .setup(|app| {
            let show = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)?;
            let check = MenuItem::with_id(app, "tray-check", "检查更新", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "tray-quit", "退出 Lshell", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &check, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                // 左键单击用于唤出窗口，右键才展开菜单
                .show_menu_on_left_click(false)
                .tooltip("Lshell - SSH 客户端")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => show_main_window(app),
                    "tray-check" => {
                        // 托盘点「检查更新」时窗口可能是隐藏的，先唤出再通知前端
                        show_main_window(app);
                        let _ = app.emit("update://check", ());
                    }
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            // 优先用窗口默认图标；取不到时回退到打包图标，避免托盘空白
            let icon = app.default_window_icon().cloned().or_else(|| {
                tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
            });
            if let Some(icon) = icon {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_data_dir,
            commands::app_info,
            commands::exit_app,
            updater::check_update,
            updater::download_update,
            updater::apply_update,
            commands::list_hosts,
            commands::get_host,
            commands::save_host,
            commands::delete_host,
            commands::duplicate_host,
            commands::list_recent_hosts,
            commands::preview_host_import,
            commands::import_hosts,
            commands::export_hosts,
            commands::list_tags,
            commands::upsert_tag,
            commands::delete_tag,
            commands::list_groups,
            commands::create_group,
            commands::rename_group,
            commands::delete_group,
            commands::reorder_hosts,
            commands::reorder_groups,
            commands::list_forwards,
            commands::save_forward,
            commands::delete_forward,
            commands::list_known_hosts,
            commands::delete_known_host,
            commands::trust_host_key,
            commands::get_setting,
            commands::set_setting,
            commands::get_all_settings,
            commands::delete_setting,
            commands::save_terminal_background,
            commands::delete_terminal_background,
            commands::terminal_background_data_url,
            commands::terminal_background_exists,
            commands::mask_secret,
            commands::record_command,
            commands::list_command_history,
            commands::clear_command_history,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::connect_host,
            commands::disconnect_host,
            commands::terminal_write,
            commands::terminal_resize,
            commands::session_state,
            commands::session_net_stats,
            commands::session_host_metrics,
            commands::session_current_user,
            commands::session_disk_usage,
            commands::read_clipboard_text,
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
