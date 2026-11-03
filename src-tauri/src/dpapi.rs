//! 系统密钥保护层
//!
//! 凭据保险库的主密钥不再由用户输入的「主密码」派生，而是交给操作系统保管：
//! Windows 上使用 DPAPI（CryptProtectData / CryptUnprotectData），
//! 密钥绑定当前 Windows 账户，换机器或换账户都无法解密。
//!
//! **为什么这样更安全**：主密码方案里，主密码是唯一的秘密，且用户可能遗忘。
//! DPAPI 方案里，Windows 登录凭据本身就是那个秘密，用户每次开机已经输入过，
//! 无需额外记忆；同时其他账户即使拿到数据库文件也解不开凭据。
//!
//! **边界**：DPAPI 保护的是「主密钥」本身。数据库里的凭据仍然用 AES-256-GCM
//! 逐条加密（见 `vault` 模块），密文与用途绑定（aad），主密钥不落明文。
//!
//! 这里直接声明 Win32 外部函数而不引入 `windows` crate：
//! DPAPI 的调用面极窄（两个函数 + 一个结构体），
//! 而 `windows` crate 会带来上万个 API 绑定和相当可观的编译时间。

/// 主密钥长度（AES-256）
pub const MASTER_KEY_LEN: usize = 32;

/// 保护方式标识，写入 `vault_meta.protector` 便于将来扩展
pub const PROTECTOR_DPAPI: &str = "dpapi";

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::ptr;

    use crate::error::{AppError, Result};

    /// Win32 `DATA_BLOB`：长度 + 缓冲区
    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    /// `CRYPTPROTECT_UI_FORBIDDEN`：失败时直接返回错误，不弹 UI
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            p_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            p_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    /// 取最后一次 Win32 错误码
    fn last_error() -> u32 {
        std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(0)
            .cast_unsigned()
    }

    /// 把 Win32 分配的输出缓冲区拷进 Vec 并释放
    ///
    /// DPAPI 用 `LocalAlloc` 分配输出，必须用 `LocalFree` 释放，
    /// 不能交给 Rust 的分配器。
    unsafe fn take_output(blob: &DataBlob) -> Vec<u8> {
        let bytes = std::slice::from_raw_parts(blob.pb_data, blob.cb_data as usize).to_vec();
        let _ = LocalFree(blob.pb_data as *mut c_void);
        bytes
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let input = DataBlob {
                cb_data: plaintext.len() as u32,
                pb_data: plaintext.as_ptr() as *mut u8,
            };
            let mut output = DataBlob {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };

            let ok = CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            );
            if ok == 0 {
                return Err(AppError::Crypto(format!(
                    "DPAPI 加密失败（错误码 {}）",
                    last_error()
                )));
            }

            Ok(take_output(&output))
        }
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let input = DataBlob {
                cb_data: ciphertext.len() as u32,
                pb_data: ciphertext.as_ptr() as *mut u8,
            };
            let mut output = DataBlob {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };

            let ok = CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            );
            if ok == 0 {
                return Err(AppError::Crypto(format!(
                    "DPAPI 解密失败（错误码 {}）：该数据可能属于其他 Windows 账户或已被篡改",
                    last_error()
                )));
            }

            Ok(take_output(&output))
        }
    }
}

/// 非 Windows 平台：直接把主密钥明文存盘
///
/// 本项目是 Windows 专用客户端（见 `tauri.conf.json` 的 msi/nsis 打包目标），
/// 这个分支只在非 Windows 开发机上存在。用 `cfg` 隔离编译，
/// 避免在 Windows 上误以为存在保护。
#[cfg(not(windows))]
mod imp {
    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>> {
        Ok(plaintext.to_vec())
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>> {
        Ok(ciphertext.to_vec())
    }
}

pub use imp::{protect, unprotect};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protect_unprotect_roundtrip() {
        let key = [7u8; MASTER_KEY_LEN];
        let wrapped = protect(&key).unwrap();
        let opened = unprotect(&wrapped).unwrap();
        assert_eq!(opened, key);
    }

    #[cfg(windows)]
    #[test]
    fn unprotect_rejects_garbage() {
        assert!(unprotect(b"not a dpapi blob").is_err());
    }
}
