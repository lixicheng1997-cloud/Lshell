# Lshell

轻量级 Windows SSH 客户端。主打主机管理、多标签终端、SFTP 文件传输与端口转发。

设计文档见 [`docs/product-design.md`](docs/product-design.md)。
品牌标识见 [`design/logo.html`](design/logo.html)。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2 |
| SSH 协议栈 | `russh` 0.65.0（锁定精确版本）+ `russh-sftp` 3.0.1 |
| 前端 | React 18 + TypeScript + Vite |
| 终端 | xterm.js（WebGL 渲染） |
| 本地存储 | SQLite（rusqlite, bundled） |
| 加密 | AES-256-GCM + Windows DPAPI（主密钥保护） |

## 开发环境要求

- **Node.js** 20+
- **Rust** 1.85+（`rustup`）
- **MSVC Build Tools**（Windows 需要 C++ 链接器）
  - 最小安装：`Microsoft.VisualStudio.Workload.VCTools` 工作负载
  - 或安装完整 Visual Studio 2022 Community

## 常用命令

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 开发模式（热重载）
npm run tauri build  # 打包 Windows 安装包（MSI + NSIS）
npm run build        # 仅构建前端
npm run assets       # 重新生成品牌资产（字标 + 应用图标）
npm run assets:verify # 校验已构建的 exe 内嵌图标是否为当前版本

cd src-tauri && cargo test    # Rust 单元测试
```

## 品牌资产与打包

字标与图标是**同一套轮廓数据**派生的产物，改一处即全链路更新：

```
scripts/make_logo.py   → design/assets/*.svg + wordmark.json + src/components/Brand.tsx
scripts/make_icons.py  → src-tauri/icons/*.png + icon.ico
                        ├→ icon.ico  → exe 的 Windows 资源（Windows 资源段）
                        ├→ *.png     → MSI / NSIS 安装包图标
                        └→ Brand.tsx → dist/ → 前端资源 → exe
```

三条保证：

1. **构建前必重生成** —— `tauri.conf.json` 的 `beforeBuildCommand` 为
   `npm run assets && npm run build`，`npm run tauri build` / `tauri dev` 都会先跑生成脚本。
2. **cargo 会因图标变化而重编资源段** —— `src-tauri/build.rs` 显式声明图标的
   `cargo:rerun-if-changed`。这一步不可省略：`tauri-winres` 不会为 `.ico` 声明重跑依赖，
   而 Cargo 一旦收到任意 `rerun-if-changed` 就切换为白名单模式，
   结果是「图标变了、配置没变 → exe 里嵌的还是旧图标」。
3. **可事后核对** —— `npm run assets:verify` 直接检查 exe 字节流里内嵌的 PNG，
   确认打进包里的就是当前这版 logo。

生成器只在内容变化时才落盘，内容相同不动 mtime，日常构建照旧走增量。

## 安装包

打包产物在 `src-tauri/target/release/bundle/`：

| 文件 | 大小 | 安装范围 | 备注 |
|---|---|---|---|
| `nsis/Lshell_0.1.0_x64-setup.exe` | 2.6 MB | **当前用户**，无需管理员 | 推荐 |
| `msi/Lshell_0.1.0_x64_en-US.msi` | 3.5 MB | 全机，需管理员 | 企业批量部署用 |

NSIS 安装到 `%LOCALAPPDATA%\Lshell\`，应用数据在 `%APPDATA%\Lshell\data\`。

**从 Git Bash 静默安装 NSIS 时注意**：`/S` 会被 MSYS 路径转换吃掉，必须用 PowerShell：

```powershell
Start-Process -FilePath ".\Lshell_0.1.0_x64-setup.exe" -ArgumentList "/S" -Wait
```

### Windows 开发环境

Rust 在 Windows 上需要 MSVC 链接器。**Git Bash 自带 GNU 版 `link.exe`，会抢占 MSVC 的链接器**（报 `link: extra operand`），必须把 MSVC 的 `bin` 放到 `PATH` 最前。仓库内已封装好：

```bash
./scripts/dev.sh      # 开发模式（自动加载 MSVC 环境）
./scripts/build.sh    # 打包
./scripts/msvc-env.sh cargo test    # 任意 cargo 命令
```

工具链要求：Node.js 20+、Rust 1.85+、VS Build Tools 2022（含 VC++ 工作负载与 Windows SDK）。

### 工具链位置（可迁移到其他盘）

本机的构建工具链放在 **E 盘**，C 盘只保留联接（junction），路径完全不变：

| 组件 | 实际位置 | C 盘看到的路径 |
|---|---|---|
| Cargo 依赖缓存 | `E:\data\.cargo` | `C:\Users\xcli\.cargo`（junction） |
| Rust 工具链 | `E:\data\.rustup` | `C:\Users\xcli\.rustup`（junction） |
| VS Build Tools | `E:\data\BuildTools` | `C:\BuildTools`（junction） |
| Windows SDK | `E:\data\WindowsKits\10` | `C:\Program Files (x86)\Windows Kits\10`（junction） |
| 项目本体 | `E:\data\Lshell` | `C:\Users\xcli\WorkBuddy\Lshell`（子项 junction） |

`scripts/msvc-env.sh` 会**自动探测**工具链位置，优先 E 盘、回退 C 盘，也可手动指定：

```bash
BUILD_TOOLS=/other/path/BuildTools WINDOWS_KITS_ROOT=/other/path/10 ./scripts/msvc-env.sh cargo build
```

> **注意**：`C:\BuildTools` 与 Windows SDK 原本由管理员权限安装，普通用户无法删除源目录或建立联接。
> 若要把它们真正搬离 C 盘，请以管理员身份执行 `scripts/finish-migration-admin.ps1`。

### 集成测试

`src-tauri/tests/integration.rs` 会连接真实服务器验证 SSH、SFTP、端口转发与终端数据通道。**只执行只读命令，不修改远端任何文件。**

```bash
export LSHELL_TEST_HOST=1.2.3.4
export LSHELL_TEST_PORT=22
export LSHELL_TEST_USER=ubuntu
export LSHELL_TEST_PASS='...'
export LSHELL_TEST_FINGERPRINT='SHA256:...'   # 已信任的主机密钥指纹
cd src-tauri && cargo test --test integration -- --nocapture
```

未设置 `LSHELL_TEST_PASS` 时测试会自动跳过。

## 项目结构

```
src/                     前端
  styles/
    tokens.css           设计变量（颜色/排版/圆角/间距），深浅双主题
    components.css       组件样式
  components/
    TitleBar.tsx         自绘标题栏（品牌 + 窗口控制）
    Brand.tsx            品牌字标组件（由 scripts/make_logo.py 生成，勿手改）
    TopBar.tsx           功能顶栏（搜索/转发/快捷键/主题/新建）
    StatusBar.tsx        底部状态栏
    Sidebar.tsx          主机库侧栏（分组树 + 标签 + 编辑/删除）
    HostDialog.tsx       新建/编辑主机对话框
    HostKeyDialog.tsx    首次连接的指纹确认框
    TerminalView.tsx     xterm.js 终端视图
    SftpPanel.tsx        SFTP 抽屉（可跟随终端目录）
    ForwardPanel.tsx     端口转发面板
    ShortcutHelp.tsx     快捷键面板
    Resizer.tsx          栏位分隔条（拖拽调宽）
    Icon.tsx             内联 SVG 图标集
  lib/
    api.ts               Rust 命令的 TS 封装
    types.ts             共享数据类型
    tabs.ts              多标签会话 store
    shortcuts.ts         全局快捷键
    theme.ts             主题管理（深色/浅色/跟随系统）
    layout.ts            栏宽等布局偏好的持久化
    cwd.ts               OSC 7 当前目录解析
    toast.tsx            Toast 通知
    terminal-theme.ts    终端配色桥接
  App.tsx                应用外壳
  styles.css             样式入口

src-tauri/               Rust 核心
  src/
    db.rs                SQLite 存储层
    vault.rs             加密保险库（AES-256-GCM）
    dpapi.rs             主密钥的 Windows DPAPI 保护层
    ssh.rs               SSH 连接与 channel 管理
    session.rs           会话管理与终端数据通道
    state.rs             全局状态
    commands.rs          Tauri 命令层
    models.rs            数据模型
    error.rs             错误类型
  tests/integration.rs   针对真实服务器的集成测试
  examples/seed_host.rs  往数据库写入测试主机的辅助脚本
  Cargo.toml

scripts/
  msvc-env.sh            加载 MSVC 构建环境
  dev.sh / build.sh      开发与打包
  make_icons.py          生成应用图标（完整 Lshell 锁定组合，与字标同源轮廓）
  make_logo.py           生成品牌字标（SVG 资产 + Brand.tsx 组件）
  ui-probe.mjs           通过 CDP 驱动运行中的应用（截图/点击/输入）
  ui-mouse.mjs           通过 CDP 模拟鼠标（悬停/拖拽/点击）
```

## 界面设计

界面规范由代码定义 —— 改 `src/styles/tokens.css` 一处即可全局换肤。

**主题**：深色（默认）/ 浅色 / 跟随系统，顶栏按钮切换，偏好写入数据库 `settings` 表。
终端配色与界面配色同源于 tokens，切换主题时 xterm 热更新，无需重连。

**配色**（「深空靛紫」）：1 个主色 `#7C8CFF` + 4 个语义色（绿/黄/红/蓝）。
界面只允许出现这 1 个高饱和色，仅用于选中、聚焦、主按钮与光标；绿黄红**仅**表示连接状态。

详细规范见 [`docs/product-design.md`](docs/product-design.md) 第 4 节。

### 主机库侧栏

- **分组**：悬停出现「重命名 / 删除」按钮。重命名是行内输入，回车提交、Esc 取消；
  删除分组时组内主机会自动移到「未分组」（外键 `ON DELETE SET NULL`）。
- **主机**：悬停出现「编辑 / 删除」按钮。编辑复用主机对话框，删除会一并关掉对应的终端标签。
- 两类删除都有二次确认，且都走 Toast 反馈结果。

### 可拖拽的栏宽

主机库与文件面板之间的分隔条可拖拽，双击恢复默认宽度。
宽度写入数据库 `settings` 表（`layout.sidebarWidth` / `layout.sftpWidth`），跨会话保留。

### SFTP 跟随终端目录

文件面板右上角的「跟随」开关打开后，面板会跟随远端 shell 当前的目录：

1. 前端扫描终端输出里的 **OSC 7** 序列（`ESC ] 7 ; file://host/path`），兼容 iTerm2 的 OSC 1337；
2. 连接就绪后，Rust 侧探测登录 shell，把跟踪脚本写到远端主目录，再让交互式 shell 加载；
   终端里只会留下一行 `. ~/.lshell_cwd.sh`，不会出现一长串脚本；
3. 脚本在每次显示提示符前上报一次当前目录（bash 走 `PROMPT_COMMAND`，zsh 走 `precmd_functions`）。

用户手动浏览过其他目录后，面板不再强制跳转，底栏出现「回到终端目录」按钮。
不支持的 shell（如 dash、cmd.exe）会明确提示，而不是静默失效。

## 当前进度

- [x] 阶段 1 骨架：工程搭建、SQLite schema、主机库 UI、加密保险库
- [x] 阶段 2 SSH 核心：连接、认证、主机密钥校验、终端交互
- [x] 阶段 3 SFTP 与端口转发
- [x] UI 重设计：Token 化设计系统、双主题、自绘标题栏、内联图标、Toast
- [ ] 阶段 4 打磨与打包发布

## 安全说明

- 凭据用 AES-256-GCM 加密存储，主密钥由 Windows DPAPI 保管。
- **无需设置主密码**，开箱即用：主密钥绑定当前 Windows 账户，
  换机器或换账户都无法解密凭据，也不会出现「忘记密码导致凭据丢失」的情况。
- 主机密钥指纹变更时应用会硬阻断，绝不静默接受。
- 应用完全离线运行，不发送任何遥测。

---

## 界面验证：CDP 驱动

WebView2 的界面无法用 `PrintWindow`/GDI 截屏（独立合成进程，截出来是全黑）。
项目提供了通过 Chrome DevTools Protocol 驱动运行中应用的脚本：

```bash
# 启动应用并开启远程调试
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  ./src-tauri/target/release/lshell.exe &

# 截图
node scripts/ui-probe.mjs shot out.png
# 点击（支持 CSS 选择器）
node scripts/ui-probe.mjs click ".tree-row"
# 读取 xterm 缓冲区内容
node scripts/ui-probe.mjs buffer
# 往终端输入并回车（逐字符派发，模拟真实打字）
node scripts/ui-probe.mjs send ".xterm-helper-textarea" "uname -a"
node scripts/ui-probe.mjs key Enter
```

`ui-probe.mjs` 用 Node 内置 WebSocket，无需额外依赖。

`ui-mouse.mjs` 在此基础上补齐了**鼠标操作**（悬停、拖拽、点击），
用于验证拖拽调宽、行内按钮这类必须靠真实指针事件才能触发的交互：

```bash
# 悬停到某个主机条目（用 CSS 强制 :hover 伪类，绕开无头环境的指针问题）
node scripts/ui-mouse.mjs "pseudo:.host-row|hover"

# 拖拽分隔条，把主机库拉宽 80px
node scripts/ui-mouse.mjs "drag:.resizer|80"

# 点击元素并截图
node scripts/ui-mouse.mjs "click:.sftp-collapsed button" "shot:out.png"
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
