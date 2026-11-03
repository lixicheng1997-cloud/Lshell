//! 凭据保险库
//!
//! 主密钥由系统密钥保护层保管（见 `dpapi` 模块），本模块只负责
//! 用 AES-256-GCM 对每条凭据做「一条一密」的加解密。
//!
//! 每条凭据使用独立随机 nonce，密文通过 aad 绑定用途
//! （`lshell:secret:<kind>`），防止把 A 类型的密文挪到 B 类型上使用。
//!
//! 主密钥本身永不以明文落盘：内存中的副本在 `Vault` 析构时 `zeroize` 擦除。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use zeroize::Zeroize;

use crate::error::{AppError, Result};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// 生成一把随机的主密钥
pub fn generate_master_key() -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    rand::fill(&mut key);
    key
}

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rand::fill(&mut buf);
    buf
}

/// 加密后的密文信封：nonce 与密文拼接存放
#[derive(Debug, Clone)]
pub struct SealedBox {
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

impl SealedBox {
    pub fn to_vec(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.nonce.len() + self.ciphertext.len());
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.ciphertext);
        out
    }

    pub fn from_vec(raw: &[u8]) -> Result<Self> {
        if raw.len() < NONCE_LEN {
            return Err(AppError::Crypto("密文数据损坏: 长度不足".into()));
        }
        Ok(SealedBox {
            nonce: raw[..NONCE_LEN].to_vec(),
            ciphertext: raw[NONCE_LEN..].to_vec(),
        })
    }
}

/// 使用主密钥加密明文。aad 用于把密文绑定到具体用途，防止密文被挪用。
pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Result<SealedBox> {
    let key = Key::<Aes256Gcm>::try_from(key.as_slice())
        .map_err(|e| AppError::Crypto(format!("密钥长度非法: {e}")))?;
    let cipher = Aes256Gcm::new(&key);

    let nonce_bytes = random_bytes(NONCE_LEN);
    let nonce = Nonce::try_from(nonce_bytes.as_slice())
        .map_err(|e| AppError::Crypto(format!("随机数长度非法: {e}")))?;

    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| AppError::Crypto(format!("加密失败: {e}")))?;

    Ok(SealedBox {
        nonce: nonce_bytes,
        ciphertext,
    })
}

/// 解密。认证失败说明密钥不对或密文被篡改，两者不做区分以免泄漏信息。
pub fn open(key: &[u8; KEY_LEN], sealed: &SealedBox, aad: &[u8]) -> Result<Vec<u8>> {
    let key = Key::<Aes256Gcm>::try_from(key.as_slice())
        .map_err(|e| AppError::Crypto(format!("密钥长度非法: {e}")))?;
    let cipher = Aes256Gcm::new(&key);

    let nonce = Nonce::try_from(sealed.nonce.as_slice())
        .map_err(|e| AppError::Crypto(format!("密文数据损坏: {e}")))?;

    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &sealed.ciphertext,
                aad,
            },
        )
        .map_err(|_| AppError::Crypto("解密失败: 密钥不匹配或数据已损坏".into()))
}

/// 保险库句柄。持有主密钥的副本，进程存活期间驻留内存。
pub struct Vault {
    key: [u8; KEY_LEN],
}

impl Vault {
    pub fn from_key(key: [u8; KEY_LEN]) -> Self {
        Vault { key }
    }

    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<SealedBox> {
        seal(&self.key, plaintext, aad)
    }

    pub fn open(&self, sealed: &SealedBox, aad: &[u8]) -> Result<Vec<u8>> {
        open(&self.key, sealed, aad)
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

/// 脱敏显示：只保留前后各 2 个字符
pub fn mask(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 4 {
        "*".repeat(chars.len())
    } else {
        format!(
            "{}{}{}",
            chars[..2].iter().collect::<String>(),
            "*".repeat(chars.len() - 4),
            chars[chars.len() - 2..].iter().collect::<String>()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = generate_master_key();
        let sealed = seal(&key, b"super secret", b"host:1").unwrap();
        let opened = open(&key, &sealed, b"host:1").unwrap();
        assert_eq!(opened, b"super secret");
    }

    #[test]
    fn wrong_aad_fails() {
        let key = generate_master_key();
        let sealed = seal(&key, b"data", b"host:1").unwrap();
        assert!(open(&key, &sealed, b"host:2").is_err());
    }

    #[test]
    fn wrong_key_fails() {
        let key = generate_master_key();
        let other = generate_master_key();
        let sealed = seal(&key, b"data", b"host:1").unwrap();
        assert!(open(&other, &sealed, b"host:1").is_err());
    }

    #[test]
    fn generated_keys_differ() {
        assert_ne!(generate_master_key(), generate_master_key());
    }

    #[test]
    fn mask_hides_middle() {
        assert_eq!(mask("abcd"), "****");
        assert_eq!(mask("abcdefgh"), "ab****gh");
    }
}
