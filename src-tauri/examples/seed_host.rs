//! 往应用数据库里写入测试主机的辅助脚本。
//!
//! 用法：cargo run --example seed_host
//!
//! 仅用于本地开发验证，会把主机档案与加密后的凭据写入应用数据库。
//!
//! 凭据由 Windows DPAPI 保护的主密钥加密，不再需要主密码。

use lshell_lib::db::Db;
use lshell_lib::models::{Host, HostInput};
use lshell_lib::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("LSHELL_TEST_HOST").unwrap_or_else(|_| "49.233.77.155".into());
    let port: i64 = std::env::var("LSHELL_TEST_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(22);
    let user = std::env::var("LSHELL_TEST_USER").unwrap_or_else(|_| "ubuntu".into());
    let pass = std::env::var("LSHELL_TEST_PASS")
        .unwrap_or_else(|_| "Yxc123321@".into());
    let alias = std::env::var("LSHELL_TEST_ALIAS").unwrap_or_else(|_| "test-ubuntu".into());

    let data_dir = lshell_lib::data_dir();
    std::fs::create_dir_all(&data_dir)?;
    let db = Db::open(&data_dir.join("lshell.db"))?;
    // 保险库由 DPAPI 保护的主密钥自动装载，无需主密码
    let state = AppState::new(db)?;

    // 写入主机
    let input = HostInput {
        alias: alias.clone(),
        address: host.clone(),
        port,
        username: user.clone(),
        auth_type: "password".into(),
        group_id: None,
        note: "集成测试用服务器".into(),
        key_path: None,
        password: Some(pass.clone()),
        key_passphrase: None,
        tag_ids: vec![],
    };

    // 已存在同名主机则更新，不重复插入
    let existing = state
        .db()?
        .list_hosts(&lshell_lib::models::HostQuery::default())?
        .into_iter()
        .find(|h| h.alias == alias);

    let host_rec = Host {
        id: existing.as_ref().map(|h| h.id).unwrap_or(0),
        alias: input.alias.clone(),
        address: input.address.clone(),
        port: input.port,
        username: input.username.clone(),
        auth_type: input.auth_type.clone(),
        group_id: None,
        note: input.note.clone(),
        key_path: None,
        sort_order: 0,
        created_at: lshell_lib::db::now_secs(),
        last_used_at: None,
        tags: vec![],
    };

    let password_id = Some(lshell_lib::state::store_secret(
        &state,
        "password",
        &pass,
        &input.alias,
    )?);

    let id = match existing {
        Some(h) => {
            state
                .db()?
                .update_host(h.id, &host_rec, password_id, None)?;
            h.id
        }
        None => state.db()?.insert_host(&host_rec, password_id, None)?,
    };
    println!("✓ 已写入主机 id={id}: {alias} ({user}@{host}:{port})");

    // 登记已知主机密钥
    let fp = std::env::var("LSHELL_TEST_FINGERPRINT").unwrap_or_else(|_| {
        "SHA256:nXyutBpsfwa8oRtST+scEMoqs/qxMvqIWDUwIMH/Abs".into()
    });
    state
        .db()?
        .insert_known_host(&host, port, "ssh-ed25519", &fp)?;
    println!("✓ 已登记主机密钥 {fp}");

    println!("\n数据目录: {}", data_dir.display());
    Ok(())
}
