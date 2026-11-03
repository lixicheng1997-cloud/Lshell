//! 文件传输任务：进度、取消与状态跟踪。
//!
//! 传输在后台运行，前端通过 `list_transfers` 轮询进度，
//! 通过 `cancel_transfer` 请求取消。
//!
//! 取消采用「协作式」：每个分块之间检查一次取消标志，
//! 因此最坏情况下要传完一个分块（64 KB）才会停下来 ——
//! 对交互式工具来说这个延迟完全无感，却避免了传输中途被打断导致的协议错乱。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 分块大小
///
/// 64 KB 是权衡：太小则系统调用开销占比高，太大则取消响应变慢、
/// 进度条的刷新也不够细腻。
const CHUNK: usize = 64 * 1024;

/// 传输完成后保留多久（秒）
///
/// 保留一会儿是为了让前端能展示「已完成 / 已失败」的最终状态，
/// 而不是传输一结束条目就凭空消失。
const RETAIN_SECONDS: u64 = 60;

/// 临时文件后缀
///
/// 上传时先写到 `<目标名>.lshell-part`，成功后再改名到最终位置；
/// 下载同理先写 `<目标名>.lshell-part`。
///
/// **为什么不用直接写目标名**：直接写会立刻把目标文件截断，
/// 一旦中途取消或失败，原有的同名文件就毁了 ——
/// 而用户可能只是传错了文件想取消。用临时文件则保证：
///
/// - 取消/失败：只删临时文件，原文件完好无损
/// - 成功：改名到目标位，替换是原子的
const PART_SUFFIX: &str = ".lshell-part";

/// 传输方向
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

/// 传输状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    /// 进行中
    Running,
    /// 已完成
    Completed,
    /// 失败
    Failed,
    /// 已取消
    Cancelled,
}

/// 传输任务的对外快照
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatus {
    pub id: u64,
    pub direction: TransferDirection,
    /// 文件名（展示用）
    pub name: String,
    pub local_path: String,
    pub remote_path: String,
    /// 总字节数；远端文件大小未知时为 0（前端按「不确定进度」处理）
    pub total: u64,
    /// 已传字节数
    pub transferred: u64,
    pub state: TransferState,
    /// 失败原因
    pub error: Option<String>,
    /// 是否可以取消（仅进行中可取消）
    pub cancellable: bool,
}

/// 传输过程的错误
#[derive(Debug)]
pub enum TransferError {
    /// 用户取消
    Cancelled,
    /// 传输失败
    Failed(String),
}

/// 一个传输任务
pub struct TransferTask {
    id: u64,
    direction: TransferDirection,
    name: String,
    local_path: String,
    remote_path: String,
    /// 总字节数
    total: AtomicU64,
    /// 已传字节数
    transferred: AtomicU64,
    state: Mutex<TransferState>,
    error: Mutex<Option<String>>,
    /// 取消标志
    cancel: AtomicBool,
    /// 结束时刻；None 表示还在进行
    finished_at: Mutex<Option<Instant>>,
}

impl TransferTask {
    fn new(
        id: u64,
        direction: TransferDirection,
        name: String,
        local_path: String,
        remote_path: String,
    ) -> Self {
        TransferTask {
            id,
            direction,
            name,
            local_path,
            remote_path,
            total: AtomicU64::new(0),
            transferred: AtomicU64::new(0),
            state: Mutex::new(TransferState::Running),
            error: Mutex::new(None),
            cancel: AtomicBool::new(false),
            finished_at: Mutex::new(None),
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    /// 设定总字节数（拿到文件大小后调用）
    pub fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::Relaxed);
    }

    /// 累加已传字节数
    pub fn add(&self, bytes: u64) {
        self.transferred.fetch_add(bytes, Ordering::Relaxed);
    }

    /// 是否已被请求取消
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// 请求取消
    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// 标记结束
    fn finish(&self, state: TransferState, error: Option<String>) {
        {
            let mut s = self.state.lock().unwrap();
            if *s != TransferState::Running {
                return;
            }
            *s = state;
        }
        *self.error.lock().unwrap() = error;
        *self.finished_at.lock().unwrap() = Some(Instant::now());
    }

    /// 生成对外快照
    pub fn snapshot(&self) -> TransferStatus {
        let state = *self.state.lock().unwrap();
        TransferStatus {
            id: self.id,
            direction: self.direction,
            name: self.name.clone(),
            local_path: self.local_path.clone(),
            remote_path: self.remote_path.clone(),
            total: self.total.load(Ordering::Relaxed),
            transferred: self.transferred.load(Ordering::Relaxed),
            state,
            error: self.error.lock().unwrap().clone(),
            cancellable: state == TransferState::Running,
        }
    }
}

/// 传输任务管理器
pub struct TransferManager {
    next_id: AtomicU64,
    tasks: Mutex<HashMap<u64, Arc<TransferTask>>>,
}

impl Default for TransferManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TransferManager {
    pub fn new() -> Self {
        TransferManager {
            next_id: AtomicU64::new(1),
            tasks: Mutex::new(HashMap::new()),
        }
    }

    /// 登记一个新任务
    pub fn start(
        &self,
        direction: TransferDirection,
        name: String,
        local_path: String,
        remote_path: String,
    ) -> Arc<TransferTask> {
        self.prune();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let task = Arc::new(TransferTask::new(
            id,
            direction,
            name,
            local_path,
            remote_path,
        ));
        self.tasks.lock().unwrap().insert(id, Arc::clone(&task));
        task
    }

    /// 请求取消；返回是否成功（任务不存在或已结束时返回 false）
    pub fn cancel(&self, id: u64) -> bool {
        let tasks = self.tasks.lock().unwrap();
        let Some(task) = tasks.get(&id) else {
            return false;
        };
        if *task.state.lock().unwrap() != TransferState::Running {
            return false;
        }
        task.request_cancel();
        true
    }

    /// 列出全部任务
    pub fn list(&self) -> Vec<TransferStatus> {
        let tasks = self.tasks.lock().unwrap();
        let mut out: Vec<TransferStatus> = tasks.values().map(|t| t.snapshot()).collect();
        out.sort_by_key(|s| s.id);
        out
    }

    /// 记录传输结果
    pub fn finish(&self, task: &TransferTask, result: Result<(), TransferError>) {
        match result {
            Ok(()) => task.finish(TransferState::Completed, None),
            Err(TransferError::Cancelled) => task.finish(TransferState::Cancelled, None),
            Err(TransferError::Failed(msg)) => task.finish(TransferState::Failed, Some(msg)),
        }
    }

    /// 清理过期的已结束任务
    fn prune(&self) {
        let mut tasks = self.tasks.lock().unwrap();
        let now = Instant::now();
        tasks.retain(|_, task| {
            let finished = task.finished_at.lock().unwrap();
            match *finished {
                Some(at) => now.duration_since(at) < Duration::from_secs(RETAIN_SECONDS),
                None => true,
            }
        });
    }
}

/// 取路径末段的文件名
pub fn file_name_of(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string()
}

/// 上传本地文件到远端
///
/// 先写到 `<目标名>.lshell-part`，成功后再改名到最终位置。
pub async fn run_upload(
    sftp: &SftpSession,
    task: &TransferTask,
    local_path: &str,
    remote_path: &str,
) -> Result<(), TransferError> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| TransferError::Failed(format!("打开本地文件失败: {e}")))?;

    let total = local
        .metadata()
        .await
        .map(|m| m.len())
        .map_err(|e| TransferError::Failed(format!("读取本地文件属性失败: {e}")))?;
    task.set_total(total);

    let part_path = format!("{remote_path}{PART_SUFFIX}");
    let mut remote = match sftp.create(&part_path).await {
        Ok(f) => f,
        Err(e) => {
            return Err(TransferError::Failed(format!("创建远端文件失败: {e}")));
        }
    };

    let mut buf = vec![0u8; CHUNK];
    loop {
        if task.is_cancelled() {
            // 只清理临时文件 —— 远端原有的同名文件不能被牵连
            remote.close().await.ok();
            let _ = sftp.remove_file(&part_path).await;
            return Err(TransferError::Cancelled);
        }

        let n = match local.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                remote.close().await.ok();
                let _ = sftp.remove_file(&part_path).await;
                return Err(TransferError::Failed(format!("读取本地文件失败: {e}")));
            }
        };
        if n == 0 {
            break;
        }

        if let Err(e) = remote.write_all(&buf[..n]).await {
            remote.close().await.ok();
            let _ = sftp.remove_file(&part_path).await;
            return Err(TransferError::Failed(format!("写入远端失败: {e}")));
        }
        task.add(n as u64);
    }

    if let Err(e) = remote.close().await {
        let _ = sftp.remove_file(&part_path).await;
        return Err(TransferError::Failed(format!("关闭远端文件失败: {e}")));
    }

    // 改名到最终位置
    replace_remote(sftp, &part_path, remote_path).await
}

/// 下载远端文件到本地
///
/// 先写到 `<目标名>.lshell-part`，成功后再改名到最终位置。
pub async fn run_download(
    sftp: &SftpSession,
    task: &TransferTask,
    remote_path: &str,
    local_path: &str,
) -> Result<(), TransferError> {
    let mut remote = sftp
        .open(remote_path)
        .await
        .map_err(|e| TransferError::Failed(format!("打开远端文件失败: {e}")))?;

    // 远端可能不返回文件大小；此时 total = 0，前端按「不确定进度」显示
    let total = remote.metadata().await.ok().and_then(|m| m.size).unwrap_or(0);
    task.set_total(total);

    let part_path = format!("{local_path}{PART_SUFFIX}");
    let mut local = match tokio::fs::File::create(&part_path).await {
        Ok(f) => f,
        Err(e) => {
            return Err(TransferError::Failed(format!("创建本地文件失败: {e}")));
        }
    };

    let mut buf = vec![0u8; CHUNK];
    loop {
        if task.is_cancelled() {
            drop(local);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(TransferError::Cancelled);
        }

        let n = match remote.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                drop(local);
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(TransferError::Failed(format!("读取远端失败: {e}")));
            }
        };
        if n == 0 {
            break;
        }

        if let Err(e) = local.write_all(&buf[..n]).await {
            drop(local);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(TransferError::Failed(format!("写入本地失败: {e}")));
        }
        task.add(n as u64);
    }

    remote
        .close()
        .await
        .map_err(|e| TransferError::Failed(format!("关闭远端文件失败: {e}")))?;
    if let Err(e) = local.flush().await {
        drop(local);
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(TransferError::Failed(format!("写入本地失败: {e}")));
    }
    drop(local);

    // 改名到最终位置
    if let Err(e) = tokio::fs::rename(&part_path, local_path).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(TransferError::Failed(format!("重命名临时文件失败: {e}")));
    }
    Ok(())
}

/// 把远端临时文件改名到最终位置
///
/// 少数 SFTP 服务器不允许直接覆盖已存在的目标，
/// 这时先删目标再改名。
async fn replace_remote(
    sftp: &SftpSession,
    from: &str,
    to: &str,
) -> Result<(), TransferError> {
    match sftp.rename(from, to).await {
        Ok(()) => Ok(()),
        Err(first) => {
            let _ = sftp.remove_file(to).await;
            if let Err(e) = sftp.rename(from, to).await {
                let _ = sftp.remove_file(from).await;
                return Err(TransferError::Failed(format!(
                    "重命名临时文件失败: {e}（首次尝试: {first}）"
                )));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager_with_task() -> (TransferManager, u64) {
        let m = TransferManager::new();
        let task = m.start(
            TransferDirection::Upload,
            "a.txt".into(),
            "/tmp/a.txt".into(),
            "/remote/a.txt".into(),
        );
        let id = task.id();
        (m, id)
    }

    #[test]
    fn file_name_of_handles_both_separators() {
        assert_eq!(file_name_of("/home/u/app.jar"), "app.jar");
        assert_eq!(file_name_of(r"C:\tmp\app.jar"), "app.jar");
        assert_eq!(file_name_of("app.jar"), "app.jar");
        assert_eq!(file_name_of("/"), "file");
        assert_eq!(file_name_of(""), "file");
    }

    #[test]
    fn transferred_bytes_accumulate() {
        let m = TransferManager::new();
        let task = m.start(
            TransferDirection::Upload,
            "a.bin".into(),
            "/tmp/a.bin".into(),
            "/remote/a.bin".into(),
        );
        task.set_total(1000);
        task.add(400);
        task.add(600);
        let snap = task.snapshot();
        assert_eq!(snap.total, 1000);
        assert_eq!(snap.transferred, 1000);
        assert_eq!(snap.state, TransferState::Running);
        assert!(snap.cancellable);
    }

    #[test]
    fn cancel_marks_request_but_state_stays_running_until_task_ends() {
        let (m, id) = manager_with_task();
        assert!(m.cancel(id), "运行中的任务应可取消");
        // 取消是协作式的：标志位已置，但任务要到下一个分块才真正停下
        let snap = m.list().into_iter().find(|s| s.id == id).unwrap();
        assert_eq!(snap.state, TransferState::Running);

        // 已结束的任务不能再取消
        m.finish(
            &m.tasks.lock().unwrap().get(&id).unwrap().clone(),
            Ok(()),
        );
        assert!(!m.cancel(id), "已结束的任务不应再取消");
    }

    #[test]
    fn finish_records_outcome() {
        let (m, id) = manager_with_task();
        let task = m.tasks.lock().unwrap().get(&id).unwrap().clone();
        m.finish(
            &task,
            Err(TransferError::Failed("磁盘满了".into())),
        );
        let snap = m.list().into_iter().find(|s| s.id == id).unwrap();
        assert_eq!(snap.state, TransferState::Failed);
        assert_eq!(snap.error.as_deref(), Some("磁盘满了"));
        assert!(!snap.cancellable);
    }

    #[test]
    fn cancelled_task_records_cancelled_state() {
        let (m, id) = manager_with_task();
        let task = m.tasks.lock().unwrap().get(&id).unwrap().clone();
        m.finish(&task, Err(TransferError::Cancelled));
        let snap = m.list().into_iter().find(|s| s.id == id).unwrap();
        assert_eq!(snap.state, TransferState::Cancelled);
        assert!(snap.error.is_none());
    }

    #[test]
    fn list_is_ordered_by_id() {
        let m = TransferManager::new();
        for i in 0..3 {
            m.start(
                TransferDirection::Upload,
                format!("{i}.txt"),
                "/tmp/a".into(),
                "/remote/a".into(),
            );
        }
        let ids: Vec<u64> = m.list().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn cancel_unknown_id_returns_false() {
        let m = TransferManager::new();
        assert!(!m.cancel(999));
    }
}
