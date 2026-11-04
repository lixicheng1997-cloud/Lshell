# Lshell

轻量级 Windows SSH 客户端，主打主机管理、多标签终端、SFTP 文件传输与端口转发。

用 Tauri 2 + Rust 构建，安装包仅 2.6 MB，完全离线运行，无遥测。

![平台](https://img.shields.io/badge/platform-Windows-blue)
![框架](https://img.shields.io/badge/Tauri-2-orange)
![语言](https://img.shields.io/badge/Rust-%E2%89%A51.85-dea584)
![前端](https://img.shields.io/badge/React-18-61dafb)

## 特性

- **主机库**：分组树 + 标签管理主机，支持行内重命名、拖拽调宽，凭据加密存储
- **多标签终端**：xterm.js WebGL 渲染，深浅双主题，终端配色随界面主题热切换
- **SFTP 文件面板**：支持「跟随终端目录」（基于 OSC 7 / OSC 1337），手动浏览后可一键回到终端目录
- **端口转发**：图形化配置管理
- **安全**：凭据 AES-256-GCM 加密，主密钥由 Windows DPAPI 保护；主机密钥指纹变更硬阻断，绝不静默接受
- **无需主密码**：开箱即用，密钥绑定当前 Windows 账户，换机器/换账户无法解密，也不存在忘记密码丢数据的问题

## 下载安装

从 [Releases](https://github.com/lixicheng1997-cloud/Lshell/releases) 下载安装包：

| 文件 | 大小 | 安装范围 | 适用场景 |
|---|---|---|---|
| `Lshell_*_x64-setup.exe`（NSIS） | 2.6 MB | 当前用户，无需管理员 | 推荐 |
| `Lshell_*_x64_en-US.msi` | 3.5 MB | 全机，需管理员 | 企业批量部署 |

NSIS 安装到 `%LOCALAPPDATA%\Lshell\`，应用数据在 `%APPDATA%\Lshell\data\`。

从 Git Bash 静默安装 NSIS 时 `/S` 会被 MSYS 路径转换吃掉，请用 PowerShell：

```powershell
Start-Process -FilePath ".\Lshell_1.0.0_x64-setup.exe" -ArgumentList "/S" -Wait
```

## 从源码构建

### 环境要求

- **Node.js** 20+
- **Rust** 1.85+（`rustup`）
- **MSVC Build Tools**（Windows 需要 C++ 链接器）
  - 最小安装：`Microsoft.VisualStudio.Workload.VCTools` 工作负载
  - 或安装完整 Visual Studio 2022 Community

### 常用命令

```bash
npm install             # 安装前端依赖
npm run tauri dev       # 开发模式（热重载）
npm run tauri build     # 打包 Windows 安装包（MSI + NSIS）
npm run build           # 仅构建前端
cargo test              # Rust 单元测试（在 src-tauri 目录下）
```

> **Windows 提示**：Git Bash 自带 GNU 版 `link.exe`，会抢占 MSVC 的链接器
> （报 `link: extra operand`），必须把 MSVC 的 `bin` 放到 `PATH` 最前。
> 仓库内已封装好脚本：
>
> ```bash
> ./scripts/dev.sh                  # 开发模式（自动加载 MSVC 环境）
> ./scripts/build.sh                # 打包
> ./scripts/msvc-env.sh cargo test  # 任意 cargo 命令
> ```

`msvc-env.sh` 会自动探测 VS Build Tools 与 Windows SDK 的安装位置，
也可用 `BUILD_TOOLS` / `WINDOWS_KITS_ROOT` 环境变量手动指定。

### 集成测试（可选）

`src-tauri/tests/integration.rs` 会连接真实服务器验证 SSH、SFTP、端口转发与终端数据通道，
只执行只读命令，不修改远端任何文件：

```bash
export LSHELL_TEST_HOST=1.2.3.4
export LSHELL_TEST_PORT=22
export LSHELL_TEST_USER=ubuntu
export LSHELL_TEST_PASS='...'
export LSHELL_TEST_FINGERPRINT='SHA256:...'   # 已信任的主机密钥指纹
cd src-tauri && cargo test --test integration -- --nocapture
```

未设置 `LSHELL_TEST_PASS` 时测试会自动跳过。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2 |
| SSH 协议栈 | `russh` 0.65.0（锁定精确版本）+ `russh-sftp` 3.0.1 |
| 前端 | React 18 + TypeScript + Vite + Zustand |
| 终端 | xterm.js（WebGL 渲染） |
| 本地存储 | SQLite（rusqlite, bundled） |
| 加密 | AES-256-GCM + Windows DPAPI（主密钥保护） |

## 项目结构

```
src/                     前端
  styles/
    tokens.css           设计变量（颜色/排版/圆角/间距），深浅双主题
    components.css       组件样式
  components/
    TitleBar.tsx         自绘标题栏（品牌 + 窗口控制）
    TopBar.tsx           功能顶栏（搜索/转发/快捷键/主题/新建）
    StatusBar.tsx        底部状态栏
    Sidebar.tsx          主机库侧栏（分组树 + 标签 + 编辑/删除）
    HostDialog.tsx       新建/编辑主机对话框
    HostKeyDialog.tsx    首次连接的指纹确认框
    TerminalView.tsx     xterm.js 终端视图
    SftpPanel.tsx        SFTP 抽屉（可跟随终端目录）
    ForwardPanel.tsx     端口转发面板
    ShortcutHelp.tsx     快捷键面板
  lib/
    api.ts               Rust 命令的 TS 封装
    types.ts             共享数据类型
    tabs.ts              多标签会话 store
    shortcuts.ts         全局快捷键
    theme.ts             主题管理（深色/浅色/跟随系统）
    cwd.ts               OSC 7 当前目录解析

src-tauri/               Rust 核心
  src/
    db.rs                SQLite 存储层
    vault.rs             加密保险库（AES-256-GCM）
    dpapi.rs             主密钥的 Windows DPAPI 保护层
    ssh.rs               SSH 连接与 channel 管理
    session.rs           会话管理与终端数据通道
    commands.rs          Tauri 命令层
  tests/integration.rs   针对真实服务器的集成测试

scripts/
  msvc-env.sh            加载 MSVC 构建环境
  dev.sh / build.sh      开发与打包
  make_logo.py           生成品牌字标（SVG 资产 + Brand.tsx 组件）
  make_icons.py          生成应用图标（与字标同源轮廓）
  ui-probe.mjs           通过 CDP 驱动运行中的应用（截图/点击/输入）
```

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl + K` | 聚焦搜索框 |
| `Ctrl + N` | 新建主机 |
| `Ctrl + W` | 关闭当前标签 |
| `Ctrl + Shift + F` | 切换文件面板 |
| `Ctrl + Shift + T` | 打开端口转发面板 |
| `Ctrl + 1/2/3` | 切换到第 1/2/3 个标签 |
| `Ctrl + Shift + C` | 复制（终端内） |
| `Ctrl + Shift + V` | 粘贴（终端内） |

点击顶栏「快捷键」可查看完整列表。

## 开发者文档

### 品牌资产

字标与图标是同一套轮廓数据派生的产物，改一处即全链路更新：

```
scripts/make_logo.py   → design/assets/*.svg + wordmark.json + src/components/Brand.tsx
scripts/make_icons.py  → src-tauri/icons/*.png + icon.ico
```

构建前会自动重新生成（`tauri.conf.json` 的 `beforeBuildCommand`），
`src-tauri/build.rs` 对图标声明了 `cargo:rerun-if-changed`，
保证图标变更后 exe 内嵌资源一定重编。构建后可用 `npm run assets:verify`
直接检查 exe 字节流里内嵌的 PNG 是否为当前版本。

生成器只在内容变化时才落盘，日常构建照旧走增量。

### 打包元数据

「作者」在安装包与系统里的落点分两处，缺一不可：

| 落点 | 体现为 |
|---|---|
| `Cargo.toml` → `authors` | Debian `Maintainer`；应用内「关于」面板 |
| `tauri.conf.json` → `bundle.publisher` | MSI `Manufacturer`、NSIS `Publisher` 与注册表键、exe `CompanyName` |
| `tauri.conf.json` → `bundle.copyright` | exe `LegalCopyright`、NSIS 安装向导底部版权行 |

`bundle.publisher` 不会被 `Cargo.toml` 的 `authors` 覆盖，两处都要写。
应用内展示的版本号与作者来自 Rust 的 `app_info` 命令，与安装包元数据同源。

### 界面验证：CDP 驱动

WebView2 的界面无法用 `PrintWindow`/GDI 截屏（独立合成进程，截出来是全黑）。
项目提供了通过 Chrome DevTools Protocol 驱动运行中应用的脚本：

```bash
# 启动应用并开启远程调试
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  ./src-tauri/target/release/lshell.exe &

node scripts/ui-probe.mjs shot out.png              # 截图
node scripts/ui-probe.mjs click ".tree-row"         # 点击（CSS 选择器）
node scripts/ui-probe.mjs buffer                    # 读取 xterm 缓冲区
node scripts/ui-probe.mjs send ".xterm-helper-textarea" "uname -a"  # 输入命令
node scripts/ui-mouse.mjs "drag:.resizer|80"        # 模拟鼠标拖拽
```

两个脚本均用 Node 内置 WebSocket，无需额外依赖。

## 设计文档

界面规范由代码定义 —— 改 `src/styles/tokens.css` 一处即可全局换肤。
详细设计规范见 [`docs/product-design.md`](docs/product-design.md)。

## 参与贡献

欢迎 Issue 与 PR：

1. Fork 本仓库并创建特性分支
2. 提交前运行 `npm run build` 与 `cargo test` 确保通过
3. 提交 PR 并附上变更说明

## 许可证

[Apache-2.0](LICENSE)
