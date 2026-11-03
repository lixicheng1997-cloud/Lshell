# Lshell 产品设计文档

> 版本 v1.0 · 日期 2026-11-02 · 状态：待评审

---

## 1. 产品定位

**Lshell** 是一款面向 Windows 的轻量级 SSH 客户端桌面应用，为日常远程运维和开发调试提供「主机管理 + 多标签终端 + SFTP 文件传输 + 端口转发」四项核心能力。

**目标用户**

| 角色 | 核心诉求 | Lshell 的对应能力 |
|---|---|---|
| 后端/运维工程师 | 管 20–200 台服务器，快速切换，改配置传文件 | 分组标签 + 全局搜索 + SFTP 面板 |
| 独立开发者/外包 | 少量固定主机，偶尔传个 jar/日志 | 加密保险库 + 一键连接 + 拖拽上传 |
| 远程调试者 | 临时开个端口访问内网服务 | 本地端口转发 |

**一句话价值**：一个不卡、不胖、不订阅的 Windows SSH 客户端。

**明确的非目标（v1 不做）**：云同步、团队协作、插件系统、串口终端、AI 助手、会话录制。

---

## 2. 功能范围

### 2.1 MVP（v1.0 必须交付）

| 编号 | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F1 | 主机管理 | 增删改查：别名、地址、端口、用户名、备注、认证方式 | P0 |
| F2 | 分组与标签 | 分组支持嵌套；标签为扁平彩色标记，一机多标签 | P0 |
| F3 | 全局搜索 | 按别名/地址/用户名/标签模糊匹配，支持 `tag:xxx` 语法 | P0 |
| F4 | 多标签终端会话 | 每个标签独立连接与终端实例，支持重命名、关闭、拖拽排序 | P0 |
| F5 | 认证 | 密码 / 私钥（ed25519、RSA、OpenSSH 新旧格式、PEM、PuTTY PPK） | P0 |
| F6 | 加密保险库 | 凭据密文落盘，主密钥由 Windows DPAPI 保管，AES-256-GCM 加密，无主密码 | P0 |
| F7 | 主机密钥校验 | SHA256 指纹，首次连接确认，变更时硬阻断 | P0 |
| F8 | SFTP 面板 | 远端目录浏览、上传/下载（拖拽）、新建目录、重命名、删除 | P0 |
| F9 | 本地端口转发 | `本地端口 → 远端地址:端口`，随会话生命周期自动启停 | P0 |
| F10 | 连接状态反馈 | 明确的连接中/成功/失败/掉线四态，失败附具体原因 | P0 |

### 2.2 v1.1（首版稳定后追加）

导入 OpenSSH `~/.ssh/config` · 远程端口转发与 SOCKS 代理 · 终端内搜索与命令历史 · 远程文件在线编辑 · 分屏 · 跳板机（ProxyJump）· 命令片段（Snippet）· 自定义配色主题

### 2.3 明确拒绝的功能（记录理由，避免后续反复讨论）

- **AI 助手 / 命令解释**：与「轻量、离线、无账号」的定位冲突，且引入 API 密钥管理负担。
- **云同步**：需要账号体系与服务器，与「无账号、可审计」的原则冲突。主机配置可导出为 JSON 文件手动同步。
- **插件系统**：首版无扩展生态，过早抽象会拖慢主线。内部模块先做好清晰边界，待有真实插件需求再开放。

---

## 3. 信息架构与核心概念

```
Lshell
├─ 主机库 (Hosts)
│   ├─ 分组树 (Group, 可嵌套)
│   └─ 标签 (Tag, 扁平多值)
├─ 会话 (Session)
│   ├─ 终端 (Terminal)
│   ├─ SFTP 通道 (复用同一条 SSH 连接)
│   └─ 转发通道 (复用同一条 SSH 连接)
└─ 安全域 (Vault)
    ├─ 主密钥 (DPAPI 绑定当前 Windows 账户)
    ├─ 凭据密文 (AES-256-GCM)
    └─ known_hosts (SHA256 指纹)
```

**关键设计约束**：一条 SSH 连接 = 一个 channel 家族。终端、SFTP、端口转发都挂在**同一条 TCP/SSH 连接**上，共享一次 TCP 握手、一次 KEX、一次主机密钥校验、一次用户认证。

- 好处：打开 SFTP 面板不需要二次登录，延迟从秒级降到毫秒级；主机密钥只校验一次；连接数不膨胀。
- 代价：底层库必须支持 channel 复用和独立流控。这直接决定了技术选型（见第 6 节）。

---

## 4. 界面设计

### 4.0 设计系统（「深空靛紫」）

界面的视觉规范由代码定义，而非文档描述 —— 改 `src/styles/tokens.css` 一处即可全局换肤。

**配色**

| 类别 | 变量 | 深色 | 浅色 |
|---|---|---|---|
| 主色 | `--accent` | `#7C8CFF` | `#4F5BE8` |
| 窗体底 | `--bg-app` | `#0B0D11` | `#FBFCFE` |
| 面板底 | `--bg-panel` | `#101319` | `#F4F6FA` |
| 卡片面 | `--bg-surface` | `#161A21` | `#FFFFFF` |
| 浮起面 | `--bg-raised` | `#1D222B` | `#FFFFFF` |
| 描边 | `--line` | `#262C37` | `#DCE1EA` |
| 主文字 | `--fg` | `#E6E9F0` | `#121722` |
| 次文字 | `--fg-muted` | `#98A1B2` | `#59616F` |
| 成功 | `--ok` | `#35D6A4` | `#0E9F6E` |
| 警告 | `--warn` | `#F0B429` | `#B7791F` |
| 危险 | `--err` | `#F2555A` | `#D93A3F` |

**用色纪律**

1. 界面里只允许出现 **1 个高饱和色**（靛紫），仅用于当前选中项、聚焦描边、主按钮、终端光标。
2. 绿 / 黄 / 红 **仅表示连接状态**，不作装饰，避免状态语义被稀释。
3. 描边一律用 `--line` 及以上层级，**禁止纯黑描边**。
4. 终端 ANSI 16 色单独一套（`--term-*`），与界面同源于 tokens，不会各自漂移。

**主题**

三态循环：深色 → 浅色 → 跟随系统。写入 `settings` 表的 `theme` 键，同时缓存在 localStorage；
切换时广播 `lshell:themechange` 事件，xterm 据此热更新配色（无需重连会话）。

**文件结构**

| 文件 | 职责 |
|---|---|
| `src/styles/tokens.css` | 设计变量（颜色/排版/圆角/间距/阴影），深浅双主题 |
| `src/styles/components.css` | 组件样式，全部引用 tokens 变量 |
| `src/styles.css` | 入口，只做两个 `@import` |
| `src/components/Icon.tsx` | 内联 SVG 图标集（24×24 视框、1.6px 描边） |
| `src/lib/theme.ts` | 主题状态、持久化、变更广播 |
| `src/lib/toast.tsx` | Toast 通知（替代旧版「错误塞状态栏」） |
| `src/lib/terminal-theme.ts` | 从 CSS 变量读终端配色，桥接给 xterm |

### 4.1 主界面布局

五段式：**标题栏 → 功能顶栏 → 三栏主体 → 状态栏**。标题栏只放品牌与窗口控件，顶栏只放可操作的功能 —— 两者分离是「不像网页」的关键。

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◇ Lshell 0.1.0                                      ─  □  ✕              │  ← 标题栏 40px（无边框自绘）
├──────────────────────────────────────────────────────────────────────────┤
│ [ 🔍 搜索主机、地址，或 tag:生产  Ctrl K ]   [转发][快捷键][◐][+ 新建主机]  │  ← 顶栏 56px
├────────────┬───────────────────────────────────────┬─────────────────────┤
│ 主机库  ⊞ ▽│ ┌ web-01 ─┬ db-01 ─┬ + ─┐            │ 远端文件        ⟳  ✕ │
│            │ │ ●       │ ●      │    │            │ /home/ubuntu         │
│ ▾ 生产环境 3│ │ root@   │ root@  │    │            │ [上传][下载][新建][←]│
│   web-01   │ │ web-01  │ db-01  │    │            │ 名称            大小  │
│   api-01   │ │ ~ $     │ ~ $    │    │            │ 📁 logs            — │
│ ▸ 测试环境 2│ └────────┴────────┴────┘            │ 📄 app.jar      2.1M │
│ 标签       │                                       │                     │
│ ● 生产  3  │                                       │ [======] 62%   7 项  │
├────────────┴───────────────────────────────────────┴─────────────────────┤
│ ● 已连接  root@10.0.0.5:22      会话 2    UTF-8    xterm-256color          │  ← 状态栏 30px
└──────────────────────────────────────────────────────────────────────────┘
```

**各区域职责**

| 区域 | 职责 | 关键交互 |
|---|---|---|
| 标题栏 | 品牌、版本、窗口控制 | 空白处拖动窗口；双击最大化；`─` 最小化 `□` 最大化 `✕` 关闭 |
| 顶栏 | 全局搜索、转发、快捷键、主题切换、快捷新建 | `Ctrl+K` 聚焦搜索；`Ctrl+N` 新建主机 |
| 左侧主机库 | 分组树 + 标签区 + 主机条目 | 单击主机 = 新建会话；双击 = 编辑配置 |
| 中间终端区 | 标签栏 + 活动终端 | `Ctrl+W` 关闭标签；滚轮回滚 10000 行 |
| 右侧 SFTP 抽屉 | 远端文件浏览与传输 | 面包屑逐级可点；双击目录进入；`Ctrl+Shift+F` 折叠 |
| 底部状态栏 | 连接状态、地址、全局计数 | 左：当前会话；右：计数与终端参数 |

**栏宽可调**：主机库与 SFTP 抽屉两侧各有一条分隔条，拖拽即可改宽，双击恢复默认；
宽度写入 `settings` 表，跨会话保留。

**主机库的行内操作**：分组与主机条目悬停时出现「重命名 / 编辑 / 删除」按钮。
分组重命名走行内输入，删除分组时组内主机自动落到「未分组」；删除主机会一并关掉对应标签。

**SFTP 跟随终端目录**：文件面板右上角的「跟随」开关打开后，面板跟随远端 shell 当前目录
（远端通过 OSC 7 上报，见 6.5）。用户手动浏览过其他目录后不再强制跳转，
底栏出现「回到终端目录」。

**状态点**：6px 圆点 + 同色 14% 光晕环，四态可辨 —— 绿（已连接）、黄（连接中，带呼吸动画）、红（失败）、灰（断开）。色弱用户也能靠光晕与动画区分。

**提示机制**：所有非阻断性反馈走右下角 Toast（错误/成功/信息），不再塞进状态栏 —— 状态栏只有一行文本，错误信息混在里面既容易溢出，也会把失败当成普通信息。

### 4.2 关键交互流程

**连接流程（含失败分支）**

```
点击主机
  → 读取主机档案（地址/端口/用户/认证方式）
  → 从保险库取凭据（主密钥由 DPAPI 自动解开，无需用户操作）
  → TCP 连接（10s 超时）
  → SSH 握手 KEX
  → 主机密钥校验
      ├─ 已知且一致 → 继续
      ├─ 首次见到 → 弹出指纹确认框，用户确认后写入 known_hosts
      └─ 指纹变更 → 【硬阻断】红色警告，必须用户显式选择「仍然连接」或取消
  → 用户认证
      ├─ 成功 → 打开 shell channel，绑定终端
      └─ 失败 → 显示具体原因（密码错误 / 密钥不匹配 / 2FA 超时）
  → 若配置了转发 → 建立本地监听
```

**失败必须给出可执行信息**：区分「网络不可达 / 端口拒绝 / 认证失败 / 主机密钥变更 / 权限不足」五类，不允许只弹一个「连接失败」。

### 4.3 新建主机对话框字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| 别名 | 文本 | 是 | 显示在列表中的名称 |
| 地址 | 文本 | 是 | IP 或域名 |
| 端口 | 数字 | 是 | 默认 22 |
| 用户名 | 文本 | 是 | |
| 认证方式 | 单选 | 是 | 密码 / 私钥 |
| 私钥路径 | 文件选择 | 私钥时 | 也支持从保险库选择已有私钥 |
| 密钥口令 | 密码 | 否 | 可单独存保险库，或每次连接时输入 |
| 分组 | 下拉 | 否 | 来自现有分组树 |
| 标签 | 多选 + 新建 | 否 | |
| 备注 | 多行文本 | 否 | |

---

## 5. 数据模型

SQLite 单文件存储，位置 `%APPDATA%/Lshell/lshell.db`。

```sql
-- 分组（自引用支持嵌套）
CREATE TABLE groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 标签（扁平）
CREATE TABLE tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#378ADD'
);

CREATE TABLE hosts (
  id            INTEGER PRIMARY KEY,
  alias         TEXT NOT NULL,
  address       TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 22,
  username      TEXT NOT NULL,
  auth_type     TEXT NOT NULL CHECK (auth_type IN ('password','key','agent')),
  group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  note          TEXT DEFAULT '',
  -- 凭据引用：指向 vault_secrets 的 id，或 NULL 表示使用 ssh-agent
  password_id   INTEGER REFERENCES vault_secrets(id),
  key_id        INTEGER REFERENCES vault_secrets(id),
  key_path      TEXT,               -- 私钥文件路径（key_type='file' 时）
  key_pass_id   INTEGER REFERENCES vault_secrets(id),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

CREATE TABLE host_tags (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (host_id, tag_id)
);

-- 加密保险库条目（密文）
CREATE TABLE vault_secrets (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('password','key','passphrase')),
  ciphertext  BLOB NOT NULL,        -- AES-256-GCM
  nonce       BLOB NOT NULL,        -- 12 bytes
  label       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- 主密钥：经 DPAPI 包装后落盘，绑定当前 Windows 账户
CREATE TABLE vault_key (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  protector    TEXT NOT NULL,       -- 保护方式：dpapi
  wrapped_key  BLOB NOT NULL,       -- DPAPI 包装后的 32 字节主密钥
  created_at   INTEGER NOT NULL
);

-- 端口转发
CREATE TABLE forwards (
  id           INTEGER PRIMARY KEY,
  host_id      INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  local_port   INTEGER NOT NULL,
  remote_host  TEXT NOT NULL,
  remote_port  INTEGER NOT NULL,
  auto_start   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host_id, local_port)
);

-- 已知主机密钥
CREATE TABLE known_hosts (
  id          INTEGER PRIMARY KEY,
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  algo        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  UNIQUE (host, port, algo)
);

-- 设置项（KV）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**索引建议**：`hosts(address)`、`hosts(alias)`、`host_tags(tag_id)`、`known_hosts(host, port)`。

---

## 6. 技术选型

### 6.1 结论

**Tauri 2 + Rust（russh）+ React + TypeScript + xterm.js**

### 6.2 选型依据

调研了 2026 年主流实现路径，核心约束是「必须能在一个连接上开多个 channel」。

| 方案 | 连接复用 | 体积 | 内存 | 结论 |
|---|---|---|---|---|
| **Tauri 2 + russh** | ✅ 原生支持 | ~10 MB | ~50 MB | **采用** |
| Tauri 2 + ssh2(libssh2) | ✅ | ~10 MB | ~50 MB | 备选，见下 |
| Electron + node-ssh | ✅ | ~120 MB | ~200 MB | 体积不达标 |
| Tauri 2 + 调用系统 ssh.exe | ❌ 无法拿到 SFTP/转发 channel | ~10 MB | ~50 MB | 排除 |
| Qt / C++ 原生 | ✅ | ~30 MB | ~40 MB | 开发效率过低 |

**为什么选 russh 而不是 ssh2（libssh2）**：

- russh 是纯 Rust 实现，与 tokio 异步运行时原生契合；ssh2 是同步阻塞的，需要 `spawn_blocking` 包一层，会话一多线程管理混乱。
- **Windows 上的关键差异**：多个独立项目实测发现，libssh2 在 Windows 走 WinCNG 后端时不支持 ed25519 和加密的 OpenSSH 格式私钥——而这恰好是国内开发者最常用的密钥组合。要支持就得捆绑 OpenSSL，引入 Perl 和 MSYS 构建链，Windows 分发复杂度陡增。
- russh 走纯 Rust 加密后端（ring / aws-lc-rs），无 C 依赖、无 Perl，跨平台算法一致。
- 代价：russh 的 API 稳定性不如 libssh2，**必须锁定精确版本号**（`russh = "=0.4x.x"`），不要用 `latest`。

**为什么用 xterm.js**：VS Code 集成终端同款，WebGL 渲染器可扛 60fps 的大流量输出（cat 一个 1GB 日志不卡），生态成熟。

### 6.3 技术栈明细

| 层 | 选型 | 锁定版本 | 说明 |
|---|---|---|---|
| 桌面框架 | Tauri 2 | `2.x` | 系统 WebView（Windows 用 WebView2），不打包 Chromium |
| 协议层 | `russh` | **`=0.65.0`（精确锁定）** | SSH2 协议栈，API 不稳定，必须锁版本 |
| SFTP | `russh-sftp` | **`=3.0.1`（精确锁定）** | 只依赖 AsyncRead+AsyncWrite，不依赖 russh |
| 加密后端 | `ring`（非默认的 `aws-lc-rs`） | `0.17.14` | **规避 NASM 依赖**，见 6.3.2 |
| 异步运行时 | `tokio` | `1.x` | russh 依赖，与 Tauri 运行时可复用 |
| 前端 | React 18 + TypeScript + Vite | | |
| 终端 | `@xterm/xterm` + `addon-webgl` + `addon-fit` | | |
| 状态管理 | Zustand | | 轻量，避免 Redux 样板代码 |
| 本地存储 | SQLite（`rusqlite`，bundled 特性） | `0.41` | 单文件数据库 |
| 加密 | `aes-gcm` | `0.11` | AES-256-GCM 加密凭据；主密钥由 Windows DPAPI 保管 |
| 随机数 | `rand` | `0.10` | 用 `rand::fill()` |

#### 6.3.1 版本锁定的三个坑（实测确认）

1. **`russh` 必须精确锁定**：`russh = "=0.65.0"`，不能用 `^0.65`。该库 API 变动频繁且多为破坏性变更。
2. **`russh` 与 `russh-keys` 已不兼容**：russh 0.65 **移除了对 `russh-keys` 的依赖**，改用 `ssh-key =0.7.0-rc.11`（预发布版）。而独立的 `russh-keys` 0.49.2 仍依赖 `ssh-key ^0.6`。两者主版本不兼容，**切勿同时引入**。项目直接使用 `russh::keys` 模块，不单独依赖 `russh-keys`。
3. **`russh-sftp` 3.x 已与 `russh` 解耦**：它不再依赖 `russh`，只要求 `AsyncRead + AsyncWrite + Unpin + Send`。这恰好让「单连接多 channel 复用」成立——`channel.into_stream()` 得到的流可直接喂给 `SftpSession::new()`。
4. **加密后端用 `ring` 而非默认的 `aws-lc-rs`**：`aws-lc-sys` 在 Windows 上编译需要 NASM 汇编器，会给每个构建者增加一个额外工具链依赖。`ring` 在 Windows 上使用预生成汇编，无需 NASM。写法：
   ```toml
   russh = { version = "=0.65.0", default-features = false, features = ["flate2", "ring", "rsa"] }
   ```

`Cargo.lock` 必须提交仓库。升级 `russh` 走独立分支做完整回归，不在主线直接升。

### 6.3.2 russh 0.65 的 API 实测差异

文档站与实际源码有出入，以 registry 中的源码为准：

| 项目 | 实际情况 | 应对 |
|---|---|---|
| `ChannelReadHalf` | **无泛型参数** | 写 `ChannelReadHalf`，不要加 `<Msg>` |
| `ChannelWriteHalf<Send>` | 有泛型参数 | `ChannelWriteHalf<client::Msg>` |
| `Handle<H>` | **不可 `Clone`**，且内部含 `UnboundedReceiver` 不是 `Sync` | 用 `Arc<tokio::sync::Mutex<Handle>>` 共享 |
| `best_supported_rsa_hash()` | 返回 `Result<Option<Option<HashAlg>>, _>`，**两层 Option** | 需要 `.ok().flatten().flatten()` |
| `channel_open_direct_tcpip` | 端口参数是 `u32` | `remote_port as u32` |
| `CheckServerKey` 返回值 | 需 `std::result::Result<bool, E>` | 模块内有 `Result` 别名时会被遮蔽 |

### 6.4 关键 API 要点

| 用途 | API |
|---|---|
| 主机密钥指纹 | `PublicKey::fingerprint(HashAlg::Sha256)` 直接给出 OpenSSH 格式 `SHA256:...` |
| 加载私钥 | `russh::keys::load_secret_key(path, passphrase)` |
| 打开 shell | `channel.request_pty(...)` → `channel.request_shell(true)` |
| 读写分离 | `channel.split()` → `(ChannelReadHalf, ChannelWriteHalf)` |
| 终端尺寸 | `ChannelWriteHalf::window_change(cols, rows, 0, 0)` |
| 端口转发 | `handle.channel_open_direct_tcpip(host, port, "127.0.0.1", 0)` |
| SFTP | `channel.request_subsystem(true, "sftp")` → `SftpSession::new(channel.into_stream())` |

**读写分离的原因**：`ChannelReadHalf::wait()` 需要 `&mut self`（独占在读取任务里），而 `ChannelWriteHalf` 的方法都是 `&self`（用 `Arc` 共享给命令层）。若不拆分，读写会互相阻塞。

### 6.5 前后端通信模型

Tauri 的 command/event 机制在高频终端输出下会有性能问题（每次按键都走 JSON 序列化）。采用**分层策略**：

| 数据类型 | 通道 | 理由 |
|---|---|---|
| 终端输入/输出 | Tauri **原始二进制通道**（`InvokeResponseBody::Raw`） | 终端输出是高频字节流，JSON 编码会明显拖慢渲染 |
| 文件列表 | Tauri command（JSON） | 体积小、结构化、频率低 |
| 连接状态变更 | 组件回调 + command 返回 | 状态变化稀疏，JSON 便于调试 |
| 配置读写 | Tauri command（JSON） | 同上 |

**终端通道的帧格式**：1 字节帧头 + 载荷。

```
0x00 + <原始字节>   数据块
0x01                会话结束
0x02 + <JSON>       会话状态变化
```

0x02 的载荷是 `SessionNotice` 的 JSON，用于把「正在重连 / 已重连 / 已断开 / 已退出」
这四种状态告诉前端。它们对用户的指引完全不同，不能只靠「连接已关闭」一句话概括。

```
{"state":"reconnecting","attempt":2,"delayMs":4000,"message":"第 2 次重连将在 4 秒后开始"}
{"state":"reconnected","message":"已重新连接"}
{"state":"disconnected","message":"重连失败，已放弃重试"}
{"state":"closed","message":"远端 shell 已退出（状态码 0）"}
```

**为什么不用 JSON 传终端数据**：最初实现用 `#[serde(tag = "type")]` 的内部标记枚举传 `Vec<u8>`，结果 serde 直接报错 —— 内部标记枚举的新类型变体不允许包含序列类型：

```
JSON error: cannot serialize tagged newtype variant TerminalMessage::Data containing a sequence
```

改成 Tauri 的 Raw 二进制通道后既绕开了这个限制，也避免了 JSON 编码开销。Tauri 对小于 1 KB 的包直接 `webview.eval` 投递，超过则走 fetch 通道，两条路径前端都收到 `ArrayBuffer`。

**会话生命周期由 Rust 侧持有**：Rust 是 SSH 连接的真正所有者，前端只是视图。连接状态、断线检测、keepalive 都在 Rust 侧管理。这样即使前端刷新，已建立的连接也能保留。

**当前目录靠 OSC 7 上报**：判断「终端当前在哪个目录」不能靠解析提示符文本 —— 各家提示符千差万别。
事实标准是 **OSC 7**（`ESC ] 7 ; file://host/path`），前端在终端字节流里扫描这个序列即可拿到目录。

远端 shell 默认不会发 OSC 7，所以连接就绪后需要注入一小段脚本：

| 环节 | 做法 |
|---|---|
| 探测 shell | 另开 exec 通道执行 `printf %s "$SHELL"`，拿到登录 shell |
| 写脚本 | SFTP 通道把脚本写到远端主目录 `~/.lshell_cwd.sh`（fish 用 `.fish`） |
| 加载脚本 | 往终端写一行 `. ~/.lshell_cwd.sh`，由交互式 shell 自己 source |
| 上报时机 | bash 挂 `PROMPT_COMMAND`，zsh 挂 `precmd_functions`，每次显示提示符前上报一次 |

用「写文件 + source」而不是直接贴一长串命令，终端里只留一行短命令。
脚本里的 bash/zsh 专有语法用 `eval` 包住，保证在任何 POSIX shell 里都不会解析报错。
同一会话只注入一次（Rust 侧 `cwd_tracking` 标记），重复调用是幂等的。

### 6.6 多标签的挂载策略

所有标签的终端**保持挂载**，只切换 `display`：

```tsx
{tabs.map(tab => (
  <div className="terminal-pane" style={{ display: tab.id === activeId ? "block" : "none" }}>
    <TerminalView sessionId={tab.id} ... />
  </div>
))}
```

原因：若按「只渲染当前标签」实现，切换标签会卸载 TerminalView，其 cleanup 会调用 `disconnectHost` —— **切走标签就断开了连接**，这是不可接受的。保持挂载同时还保留了每个标签各自的回滚历史。

终端被 `display:none` 隐藏后再显示，尺寸会变化，因此用 `ResizeObserver` 监听容器尺寸并重新 `fit()`。

### 6.7 断线检测与自动重连

连接生命周期完全由 Rust 侧持有（见 6.5）。前端只是视图，不参与连接管理。

#### 心跳：判定链路是否还活着

SSH 协议有标准的 `keepalive@openssh.com` 全局请求，服务端必然回应，
因此可以安全地当作链路探针。russh 的 `client::Config` 原生支持：

```rust
client::Config {
    // 不用 inactivity_timeout：语义是「多久没收到任何数据就掐断连接」，
    // 会误杀正在挂机的交互式终端（挂机 5 分钟必掉线）。
    inactivity_timeout: None,
    keepalive_interval: Some(Duration::from_secs(15)),
    keepalive_max: 3,
}
```

**判定窗口 = 15s × 3 = 45 秒**。这个取值要在两个错误之间取平衡：

- 窗口太小 → 网络抖一下（丢包、基站切换、VPN 重连）被误判成断线，白白触发重连；
- 窗口太大 → 用户要等很久才知道连接已断。

服务端连续 3 次不回应心跳，russh 关闭连接，终端读取循环随即拿到 `None`，
判定为链路断开。

#### 区分「远端退出」与「链路断开」

这是重连逻辑的前提，判错会导致「用户敲了 exit 后应用疯狂重连」。

| SSH 消息 | 判定 | 处置 |
|---|---|---|
| `exit-status` / `EOF` | 远端 shell 正常退出 | 提示已退出，**不重连** |
| 通道被销毁（`None`） | 链路异常断开 | 进入重连流程 |

对应到 `ssh::ReadStep` 枚举：`Data` / `Exited(i32)` / `Lost(String)`。

#### 守护任务

每个会话有一个 Rust 侧的守护任务（supervisor），负责：

```
连接成功 → 等待终端结束信号
   ↓ Lost
标记状态为 Reconnecting，发状态帧通知前端
   ↓
指数退避重试：2s → 4s → 8s → 16s → 30s → 30s（共 6 次，累计约 90 秒）
   ↓ 每次尝试
   ├─ 私钥加载失败 → 立即放弃（重试无意义）
   ├─ 主机密钥校验失败 → 立即放弃（指纹变更，硬阻断）
   ├─ 连接失败 → 退避后重试
   └─ 成功 → 恢复会话，发状态帧 Reconnected
```

**退避的意义**：服务端长时间不可达时，避免把客户端打成「重连风暴」。

#### 重连后恢复什么

| 对象 | 处置 | 原因 |
|---|---|---|
| 终端通道 | 重新打开 shell，新建写句柄 | 旧 channel 绑定在已断开的连接上 |
| 会话管理器里的写句柄 | 替换为新句柄 | 前端每次写入都从管理器取句柄，替换后自动生效 |
| SFTP 子系统 | 清空缓存，下次访问时重建 | 同上 |
| 端口转发 | 按 `auto_start` 规则重建监听 | 旧监听挂在死连接上 |
| 目录跟踪脚本 | 重新探测 shell、重新注入 | 脚本存在远端，但新会话没加载它 |

#### 凭据与安全

- 私钥**不保存解析后的对象**，只记路径与口令，重连时从磁盘重新加载 ——
  磁盘上的私钥若被替换，重连用的是新文件。
- 私钥加载失败立即放弃重连，不做无意义的重试。
- 重连时主机密钥仍走完整校验：指纹变更**硬阻断**，绝不静默接受。
- 私钥口令在会话生命周期内驻留内存是可接受的：保险库主密钥本来就随进程常驻内存。

#### 建连超时

`ConnectParams.timeout`（对应 OpenSSH 的 `ConnectTimeout`）默认 15 秒。
OpenSSH 的默认值是「不超时」，但对桌面客户端来说「点连接后界面永远转圈」
比「明确报错」糟糕得多。

---

### 6.8 文件传输：进度与取消

传输是一个「会跑很久的 I/O」，三个问题必须一起解决：
**不能卡住界面**、**用户要看得见进度**、**用户能中途放弃**。

#### SFTP 会话必须可并发

初版把 SFTP 会话放在 `Arc<Mutex<Option<SftpSession>>>` 里，操作时持锁。
问题很实际：传输期间锁被占住，目录列表、新建、删除全部卡住 —— 传一个 100 MB 文件，
文件面板就僵住了。

`SftpSession` 的所有方法都取 `&self`，内部是 `Arc<RawSftpSession>`（多路复用）。
因此改成 `Arc<Mutex<Option<Arc<SftpSession>>>>`：

- 互斥锁只保护「首次打开」这一瞬间；
- 拿到会话后立刻释放锁，操作全程不持锁；
- 同一个会话实例可以被多个任务并发使用。

这是「一条 SSH 连接 = 一组 channel」这条设计约束的必然结果：
SFTP 子系统本身就在同一条连接上，它不是独占资源。

#### 传输任务

传输在后台运行，命令立即返回任务 id：

```rust
pub async fn sftp_upload(...) -> Result<u64>   // 返回传输 id
pub fn list_transfers(...) -> Vec<TransferStatus>
pub fn cancel_transfer(id: u64) -> bool
```

任务状态由 Rust 侧维护，前端轮询 `list_transfers`（500 ms 一次）拿快照。
选轮询而非事件推送，是因为事件有「监听器还没建立就发事件」的时序问题，
而轮询在传输这种低频场景下开销可忽略，且天然能覆盖「传输在别处启动」的情况。

**分块传输**：64 KB 一块，每块之间检查一次取消标志。
64 KB 是权衡 —— 太小则系统调用开销占比高，太大则取消响应变慢、进度条也不够细腻。

**取消是协作式的**：置标志位，传输在下一个分块边界停下。
好处是不会打断到一半的协议交互。

**取消后清理半截文件**：上传时删远端，下载时删本地。
留一个看似完整的半截文件比传输失败更危险 —— 用户会以为文件是好的。

#### 拖拽上传

用 Tauri 的 `getCurrentWebview().onDragDropEvent()`。
这个事件是 **webview 级**的：整个窗口都能收到，与 HTML5 的 DOM 拖放事件不同。

因此要额外做落点判断：

- 事件坐标是**物理像素**，DOM 坐标是 **CSS 像素**，要除以 `window.devicePixelRatio`；
- 只有落在文件面板的矩形范围内才响应，否则忽略。

拖入文件夹时，Rust 侧先检查本地路径是不是目录，给出明确提示，
而不是让远端报一个费解的错。

## 7. 安全设计

### 7.1 凭据保险库

```
主密钥 (32 字节随机)
  └─ DPAPI 包装后落盘 → 绑定当前 Windows 账户
                              │
                              ├─ 加密凭据（AES-256-GCM，每条独立 nonce）
                              └─ aad 绑定用途（lshell:secret:<kind>）
```

- **主密钥由系统保管，不由用户记忆**。Windows 上走 DPAPI（`CryptProtectData`），
  密文绑定当前 Windows 账户：换机器或换账户都无法解密。用户在开机时已经输入过
  Windows 登录凭据，无需再记一串主密码。
- **主密钥永不以明文落盘**，明文只在内存中存在，使用后 `zeroize` 擦除。
- 凭据密文依旧逐条 AES-256-GCM 加密，aad 把密文绑定到具体用途，
  防止把 A 类型的密文挪到 B 类型上使用。
- **无主密码即无「忘记」问题**：主密码方案里，遗忘主密码 = 凭据永久丢失，
  这在个人工具里是纯粹的负担而非安全保障。
- **边界要讲清楚**：DPAPI 的信任边界是「当前 Windows 账户」。
  能以该账户身份运行的进程都能解开主密钥 —— 这与主密码方案的安全性定位不同，
  但对本产品的使用场景（个人单机 SSH 客户端）是合理取舍。
- 无后门：加密逻辑开源可审计，不做「恢复码」这类绕过机制。

### 7.2 主机密钥策略

- 指纹格式：`SHA256:base64`（OpenSSH 2020+ 标准格式）。
- 首次连接弹出确认框，展示算法、指纹、服务器地址，用户显式确认才写入 `known_hosts`。
- 指纹变更时**硬阻断**：红色警告 + 展示新旧指纹，要求用户显式确认「仍然连接」，绝不静默接受。
- 可选的「信任此主机所有密钥」模式需二次确认，且在 UI 上明确标注风险。

### 7.3 其他安全措施

- 私钥口令、密码在日志和错误提示中一律脱敏（只显示前后各 2 字符）。
- 不记录完整会话内容到磁盘（会话录制明确不在 v1 范围）。
- 不发送任何遥测。应用完全离线运行。

---

## 8. 架构分层

```
┌─────────────────────────────────────────────────────┐
│  前端 (React + TS)                                   │
│  ┌───────────┐ ┌─────────┐ ┌────────┐ ┌───────────┐ │
│  │ 主机库    │ │ 标签栏  │ │ 终端   │ │ SFTP 抽屉 │ │
│  │ 侧栏      │ │         │ │xterm.js│ │           │ │
│  └───────────┘ └─────────┘ └────────┘ └───────────┘ │
└───────────────────────┬─────────────────────────────┘
                        │ command / event / 二进制流
┌───────────────────────┴─────────────────────────────┐
│  Rust 核心 (Tauri commands)                          │
│  ┌────────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ Vault      │ │ HostStore│ │ SessionManager    │  │
│  │ 加密保险库 │ │ SQLite   │ │ 连接池/状态机     │  │
│  └────────────┘ └──────────┘ └─────────┬─────────┘  │
└─────────────────────────────────────────┼───────────┘
                                          │
┌─────────────────────────────────────────┴───────────┐
│  russh (SSH2 协议栈)                                 │
│  ┌────────┐ ┌──────┐ ┌───────────┐ ┌────────────┐  │
│  │Shell   │ │ SFTP │ │ 端口转发  │ │ HostKey    │  │
│  │Channel │ │Subsys│ │ Channel   │ │ 校验       │  │
│  └────────┘ └──────┘ └───────────┘ └────────────┘  │
└─────────────────────────────────────────────────────┘
```

**关键模块职责**

| 模块 | 职责 |
|---|---|
| `Vault` | 加密/解密凭据，主密钥内存擦除 |
| `HostStore` | SQLite CRUD，搜索与分组查询 |
| `SessionManager` | 会话状态机（新建/连接中/已连接/失败/掉线），连接复用 |
| `SshChannel` | 封装 russh 的 shell / sftp / direct-tcpip channel，统一事件流 |
| `ForwardManager` | 本地端口监听，绑定到会话生命周期 |
| `HostKeyStore` | 指纹存储与比对 |

---

## 9. 迭代路线

### 阶段 1：骨架与主机库（1–2 周）
- [x] Tauri 工程搭建、Rust/TS 双端联通
- [x] SQLite schema、HostStore 完整 CRUD
- [x] 左侧主机库 UI、分组树、标签、搜索
- [x] 加密保险库（AES-256-GCM + Windows DPAPI 保管主密钥）含单元测试
- [x] 应用图标生成脚本
- **里程碑**：能添加主机并在列表中管理，尚不能连接

### 阶段 2：SSH 核心（2–3 周）
- [x] russh 接入：TCP 连接、KEX、主机密钥校验（Trusted/Unknown/Mismatch 三态）
- [x] 密码认证、私钥认证
- [x] 终端通道读写分离（读半边独占任务，写半边 Arc 共享）
- [x] Tauri 二进制通道打通终端数据流
- [x] 断线检测与自动重连（心跳保活 + 指数退避，见 6.7）
- [ ] 键盘交互式认证（2FA）
- **里程碑**：能稳定连接多台主机并交互式操作终端

### 阶段 3：SFTP 与转发（2 周）
- [x] `russh-sftp` 接入，右栏抽屉 UI
- [x] 目录浏览、上传/下载（拖拽）、新建/重命名/删除
- [x] 进度条与取消
- [x] 本地端口转发：监听、转发、状态展示
- **里程碑**：不离开应用完成日常传文件与端口映射

### 阶段 4：打磨与发布（1–2 周）
- [x] 键盘快捷键（Ctrl+K/N/W、Ctrl+Shift+F/T、Ctrl+1..3）+ 快捷键帮助面板
- [ ] 主题、字体与行高设置
- [x] Windows 打包（MSI + NSIS），NSIS 为 per-user 安装
- [ ] 性能压测（100 台主机、长时间 cat、并发 SFTP）
- [ ] 代码签名（v1 暂不采购）
- [x] 文档与开源仓库整理

### 阶段 5：可靠性与传输（2026-11-03 追加）
- [x] 心跳保活：`keepalive@openssh.com`，15s × 3（45 秒判定断开）
- [x] 区分「远端正常退出」与「链路异常断开」
- [x] 指数退避自动重连：2s → 4s → 8s → 16s → 30s → 30s
- [x] 重连后恢复终端通道、SFTP 子系统、端口转发、目录跟踪
- [x] 状态帧协议（0x02），前端显示「重连中 / 已重连 / 已断开」
- [x] 建连超时（15 秒），避免连接时界面无限等待
- [x] 传输任务层：分块传输、进度累计、协作式取消、半截文件清理
- [x] SFTP 会话改为并发共享（传输不再阻塞文件面板）
- [x] 拖拽上传、传输进度列表、取消按钮

**总工期估算：6–9 周**（单人全职，中途不插入新需求的前提下）

### 交付产物（2026-11-02）

| 产物 | 大小 | 说明 |
|---|---|---|
| `nsis/Lshell_0.1.0_x64-setup.exe` | 2.62 MiB | per-user 安装，无需管理员，推荐 |
| `msi/Lshell_0.1.0_x64_en-US.msi` | 3.49 MiB | per-machine 安装，需管理员 |
| `target/release/lshell.exe` | 7.1 MiB | 免安装直接运行 |

安装位置 `%LOCALAPPDATA%\Lshell\`，应用数据 `%APPDATA%\Lshell\data\lshell.db`。

**已用安装后的程序做过端到端验证**：连接真实服务器、执行命令、快捷键（Ctrl+K 聚焦搜索框、Ctrl+Shift+F 展开文件面板）均正常。

### 已验证的构建结果（2026-11-02）

| 项目 | 结果 |
|---|---|
| Rust 库编译 | `cargo check --lib` 零错误零警告 |
| 单元测试 | 7 项全部通过 |
| 集成测试（真实服务器） | 7 项全部通过 |
| Release 可执行文件 | **7.2 MB**（目标 < 30 MB，达成） |
| 前端构建 | `tsc --noEmit` + `vite build` 均通过 |
| 数据库初始化 | 9 张表 + 5 个索引自动创建成功 |
| 凭据落盘加密 | 数据库文件中搜不到明文密码；主密钥以 DPAPI 密文形式存储 |

前端产物 554 KB（gzip 151 KB），其中 xterm.js 占大头；后续可按需做代码分割。

### 集成测试覆盖（针对真实 OpenSSH 服务器）

测试文件：`src-tauri/tests/integration.rs`。连接参数从环境变量读取，凭据不入库。

| 测试 | 验证内容 |
|---|---|
| `test_password_auth_and_host_key` | 密码认证 + 主机密钥校验通过 |
| `test_readonly_commands` | 执行 `echo` / `whoami` / `pwd` / `uname -a` 并校验输出 |
| `test_interactive_shell` | PTY 交互式 shell，读写分离后仍能正常收发 |
| `test_sftp_listing` | 复用同一连接打开 SFTP 子系统并列出目录 |
| `test_port_forwarding` | 复用同一连接建立 `direct-tcpip` 通道 |
| `test_terminal_channel_roundtrip` | **完整终端数据通道**：写入命令 → 收到输出（实测 1093 字节）+ 尺寸调整 |
| `test_fingerprint_format` | russh 计算的指纹与 `ssh-keyscan` 采集结果一致 |
| `test_host_key_mismatch_is_blocked` | 指纹不匹配时硬阻断，且错误信息不泄露凭据 |

**测试纪律**：集成测试只执行只读命令，绝不修改或删除远端任何文件。

运行方式：

```bash
LSHELL_TEST_HOST=... LSHELL_TEST_USER=... LSHELL_TEST_PASS=... \
LSHELL_TEST_FINGERPRINT=SHA256:... \
  cargo test --test integration -- --nocapture
```

### 会话层与 IPC 解耦

`session::attach_terminal` 接收一个 `OutputSink` 回调而不是 Tauri 的 `Channel`：

```rust
pub type OutputSink = Arc<dyn Fn(TerminalMessage) + Send + Sync>;
```

这样会话逻辑不依赖 IPC 框架，集成测试可以直接注入 mpsc 接收端来验证数据通路。生产环境在命令层做适配：

```rust
let sink: session::OutputSink = Arc::new(move |msg| { let _ = channel.send(msg); });
```

### 主机密钥确认流程（实现细节）

首次连接某台主机时，Rust 侧**不直接失败**，而是返回结构化的 `ConnectOutcome::NeedsHostKeyTrust { fingerprint, algo }`：

```
connect_host → NeedsHostKeyTrust
   ↓ 前端弹出 HostKeyDialog，展示指纹 + 复制按钮
   ↓ 用户点「信任并连接」
   ↓ 调用 trust_host_key 写入 known_hosts
   ↓ 重连（此时指纹已登记，直接通过校验）
```

这样做的原因：把「解析错误字符串」换成结构化返回值，前端不需要靠正则匹配错误消息来判断状态。指纹变更（`Mismatch`）仍然是硬阻断，绝不放行。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| russh API 不稳定，上游 breaking change | 编译中断 | 锁定精确版本 + `Cargo.lock` 提交仓库；升级走独立分支做回归 |
| Windows 缺 WebView2 Runtime | 应用无法启动 | Tauri 打包配置 `webviewInstallMode: downloadBootstrapper`，首次启动自动装 |
| 主机密钥校验误报 | 用户无法连接自己的机器 | 指纹确认框提供「复制指纹」按钮，方便用 `ssh-keygen -lf` 核对 |
| 大文件传输阻塞 UI | 界面卡死 | 传输在 Rust 侧异步执行 + 分片，进度经 event 回传，前端不阻塞 |
| 高频终端输出性能 | 终端掉帧 | xterm.js WebGL 渲染 + Rust 侧批量读缓冲（16ms 攒批） |
| 数据库被拷到别的账户/机器 | 凭据无法解开 | DPAPI 绑定 Windows 账户，跨账户解密必然失败；此时提示用户重新录入凭据 |
| 无代码签名证书 | SmartScreen 拦截，用户不敢装 | v1 先用「更多信息 → 仍要运行」引导；后续购买 OV 证书 |
| 心跳判定窗口选小 | 网络抖动被误判为断线，触发多余重连 | 判定窗口 45 秒，覆盖常见的丢包与 VPN 重连 |
| 重连风暴 | 服务端不可达时客户端持续高频重试 | 指数退避 2s→30s，6 次后放弃 |
| 重连后子通道未重建 | SFTP / 转发 / 目录跟踪静默失效 | 重连成功后统一恢复，详见 6.7 |
| 传输独占 SFTP 会话 | 传输期间文件面板整体卡死 | SFTP 会话改为 `Arc` 共享，全程不持锁，详见 6.8 |
| 取消后残留半截文件 | 用户以为文件完整，实际是残缺的 | 取消时删除远端/本地的半截文件 |

---

## 11. 验收标准（MVP 完成定义）

1. 能在 Windows 10/11 上安装并启动，安装包 < 30 MB，空闲内存 < 80 MB
2. 首次启动无需任何设置即可用；凭据由系统密钥自动保护
3. 能添加 100 台主机，用分组和标签组织，搜索响应 < 100ms
4. 能同时打开 10 个终端标签，各自独立交互，切换无卡顿
5. 密码认证和私钥认证（含加密私钥）均通过真实服务器验证
6. 主机密钥变更时应用明确阻断并提示
7. SFTP 能浏览目录、上传/下载文件，100MB 文件传输稳定
8. 本地端口转发可用，浏览器能通过转发访问远端服务
9. 断网后状态栏正确显示「已断开」，且保留终端历史输出
10. 所有凭据在数据库中均为密文，源码与日志中无明文密码
11. 静默断网（无 FIN/RST）后 45 秒内判定断开，界面显示「重连中」
12. 服务端恢复后自动重连成功，终端通道、SFTP、端口转发、目录跟踪全部恢复
13. 能把本地文件拖进文件面板上传，传输过程中显示进度、速度与剩余时间
14. 传输中途可取消，取消后远端与本地都不残留半截文件
15. 传输进行中仍能正常浏览远端目录、创建与删除文件

---

## 12. 已决策事项（2026-11-02 确认，作为开发基线）

设计原则：**功能简单、实用**。以下决策不再反复讨论，开发时直接按此执行。

| 问题 | 决策 | 影响面 |
|---|---|---|
| ssh-agent 转发的密钥 | **首版不做**，仅支持 password 与私钥文件（agent 归 v1.1） | 认证模块 |
| SFTP 远程文件在线编辑 | **首版不做**，只做浏览与传输（编辑归 v1.1） | SFTP 模块 |
| 命令行参数启动直连 | **首版不做** | 主进程入口 |
| 保险库空闲自动上锁 | 主密钥由 DPAPI 自动解开，无需上锁流程 | Vault 模块 |
| 代码签名证书 | **v1 暂不采购**，发布时引导用户手动放行 SmartScreen | 发布环节 |
| 分组嵌套层级 | 数据结构保留 `parent_id`，UI 首版只做**一级分组** | HostStore / 侧栏 UI |
| 终端滚轮回滚长度 | 固定 10000 行，不做可配置项 | 终端模块 |

### 12.1 开发环境要求（Windows）

| 组件 | 要求 | 备注 |
|---|---|---|
| Node.js | 20+ | 前端构建 |
| Rust | 1.85+（`rustup install stable`） | `x86_64-pc-windows-msvc` 目标 |
| MSVC Build Tools | VC++ 工作负载 | Rust 在 Windows 上需要 `link.exe` |
| Windows SDK | 随 Build Tools 安装 | 提供 `kernel32.lib` 等 |

**Git Bash 的坑**：Git 自带 GNU 版 `link.exe`，会遮蔽 MSVC 的链接器，导致 cargo 报 `link: extra operand`。必须把 MSVC 的 `bin` 目录放在 `PATH` 最前面。项目内已封装 `scripts/msvc-env.sh` 自动完成这件事（含 MSVC 版本与 SDK 路径探测），`scripts/dev.sh` 和 `scripts/build.sh` 都基于它。

安装命令：

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools \
  --override "--quiet --wait --passive --norestart \
               --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

> 用 winget 的 `--override` 传参时，若参数含空格或引号，Git Bash 下会被吞掉，导致安装器以退出码 87 失败。稳妥做法是直接下载 `vs_BuildTools.exe` 再执行。

**范围裁剪的共同原则**：数据结构按最终形态设计（留好扩展位），但 UI 和交互只实现当前层级需要的那一层。这样后续加功能不需要迁移数据，但首版的工作量严格受控。

### 首版刻意不做的「看起来该有」的东西

以下功能在同类产品里很常见，但本项目首版**全部排除**，以保证「简单实用」：

- 主机配置导入导出（等积累到几十台主机后按需补）
- 连接历史与最近使用列表
- 终端右键菜单与复制粘贴增强（先支持 Ctrl+Shift+V / Ctrl+Shift+C）
- 批量主机操作（批量连接、批量改端口）
- 隧道配置的图形化管理界面（端口转发规则直接在主机编辑对话框里配）
- 托盘驻留与开机自启
