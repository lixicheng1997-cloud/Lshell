//! 应用全局状态
//!
//! Rust 侧持有数据库与保险库句柄。
//!
//! **锁顺序约定**：任何时候只允许同时持有一把锁（vault 或 db）。
//! 需要两者时按「先取数据、释放、再操作」的顺序拆开，绝不嵌套持有。

use std::sync::Mutex;

use crate::db::Db;
use crate::dpapi;
use crate::error::{AppError, Result};
use crate::transfer::TransferManager;
use crate::vault::{self, Vault};

pub struct AppState {
    pub db: Mutex<Db>,
    /// 凭据保险库句柄；持有主密钥副本，进程存活期间驻留内存
    pub vault: Mutex<Vault>,
    /// 正在进行的文件传输任务（进度与取消）
    pub transfers: std::sync::Arc<TransferManager>,
}

impl AppState {
    pub fn new(db: Db) -> Result<Self> {
        let vault = load_vault(&db)?;
        Ok(AppState {
            db: Mutex::new(db),
            vault: Mutex::new(vault),
            transfers: std::sync::Arc::new(TransferManager::new()),
        })
    }

    pub fn db(&self) -> Result<std::sync::MutexGuard<'_, Db>> {
        self.db.lock().map_err(|_| AppError::Internal("数据库锁被占用".into()))
    }

    pub fn vault(&self) -> Result<std::sync::MutexGuard<'_, Vault>> {
        self.vault
            .lock()
            .map_err(|_| AppError::Internal("保险库锁被占用".into()))
    }
}

/// 装载保险库：读取已存在的主密钥，或首次运行时生成一对
///
/// 主密钥由系统密钥保护层（Windows DPAPI）加密后落盘，
/// 解开它不需要用户输入任何东西 —— 这正是取消主密码的前提。
///
/// 首次运行时生成随机主密钥并用 DPAPI 包装存库；
/// 之后每次启动都用 DPAPI 把它解开。
fn load_vault(db: &Db) -> Result<Vault> {
    match db.vault_key()? {
        Some((_protector, wrapped)) => {
            let key = dpapi::unprotect(&wrapped).map_err(|e| {
                AppError::Crypto(format!("无法读取保险库主密钥: {e}"))
            })?;
            let key: [u8; dpapi::MASTER_KEY_LEN] = key.try_into().map_err(|_| {
                AppError::Crypto("保险库主密钥长度异常，数据库可能已损坏".into())
            })?;
            Ok(Vault::from_key(key))
        }
        None => {
            // 首次运行：生成主密钥，用 DPAPI 包装后落盘
            let key = vault::generate_master_key();
            let wrapped = dpapi::protect(&key)?;
            db.init_vault(dpapi::PROTECTOR_DPAPI, &wrapped)?;
            Ok(Vault::from_key(key))
        }
    }
}

/// 凭据的附加认证数据：只绑定类型，保证写入与读取时完全一致
fn secret_aad(kind: &str) -> Vec<u8> {
    format!("lshell:secret:{kind}").into_bytes()
}

/// 存储一条凭据，返回 secret id
pub fn store_secret(state: &AppState, kind: &str, plaintext: &str, label: &str) -> Result<i64> {
    let sealed = {
        let vault_guard = state.vault()?;
        vault_guard.seal(plaintext.as_bytes(), &secret_aad(kind))?
    };

    let db = state.db()?;
    db.insert_secret(kind, &sealed.nonce, &sealed.ciphertext, label)
}

/// 读取一条凭据
pub fn load_secret(state: &AppState, id: i64) -> Result<String> {
    let (kind, nonce, ciphertext) = {
        let db = state.db()?;
        db.get_secret(id)?
            .ok_or_else(|| AppError::NotFound(format!("凭据 {id} 不存在")))?
    };

    let sealed = vault::SealedBox { nonce, ciphertext };
    let plaintext = {
        let vault_guard = state.vault()?;
        vault_guard.open(&sealed, &secret_aad(&kind))?
    };

    Ok(String::from_utf8_lossy(&plaintext).into_owned())
}
