//! 应用错误类型

use serde::Serializer;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("加密错误: {0}")]
    Crypto(String),

    #[error("连接错误: {0}")]
    Connection(String),

    #[error("认证失败: {0}")]
    Auth(String),

    #[error("主机密钥校验失败: {0}")]
    HostKey(String),

    #[error("文件传输错误: {0}")]
    Transfer(String),

    #[error("参数错误: {0}")]
    Invalid(String),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("操作被取消")]
    Cancelled,

    #[error("内部错误: {0}")]
    Internal(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
