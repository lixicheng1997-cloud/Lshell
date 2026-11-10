# 自动更新发布流程

Lshell 使用 Tauri v2 updater，更新源是静态文件：

```
https://xichengli.cloud/lshell/latest.json
```

客户端启动约 30 秒后静默检查一次；托盘菜单与「设置 → 诊断 → 检查更新」提供手动入口。
发现新版本只提示，用户确认后才下载；下载完成再次提示「重启以完成更新」。

## 1. 签名密钥

- 公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
- 私钥只保存在仓库外：`C:\Users\xcli\.tauri-keys\lshell-updater.key`（本机生成时的路径）。
  - **不要提交到版本库，不要粘贴到聊天/日志/CI 日志里。**
  - 请立即备份到离线介质或密码管理器；丢失私钥后，已发布的旧版本将无法验证新更新。
  - 私钥口令为空（生成时使用 `--ci`）。若需要口令保护，可在另一台机器重新生成一对密钥，
    并同步替换配置里的公钥；旧客户端需要手动升级一次。
- 重新生成密钥（仅在确有必要时）：

  ```powershell
  npx tauri signer generate -w <仓库外路径>\lshell-updater.key
  ```

  把生成的 `.pub` 文件内容整行填入 `tauri.conf.json` 的 `pubkey`。

## 2. 构建

1. 修改 `src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 里的版本号（两者必须一致）。
2. 签名私钥配置在仓库根目录的 `.env`（已被 `.gitignore` 忽略，不会提交）：

   ```
   TAURI_SIGNING_PRIVATE_KEY=C:\Users\xcli\.tauri-keys\lshell-updater.key
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
   ```

   值是私钥文件的路径，构建脚本会在运行时读取其内容注入环境变量。
   换机器时改路径即可，同样不要把私钥内容写进仓库。

3. 打包（当前只产出 NSIS）。Tauri CLI 不会自动加载 `.env`，
   请用 `npm run build:app`（经 `scripts/tauri-build.mjs` 注入环境变量后执行 `tauri build`）：

   ```powershell
   npm run build:app
   ```

   若坚持手动方式，也可按旧流程设置环境变量后直接 `npm run tauri build`。

4. 产物：

   ```
   src-tauri/target/release/bundle/nsis/Lshell_<version>_x64-setup.exe
   src-tauri/target/release/bundle/nsis/Lshell_<version>_x64-setup.exe.sig
   ```

   `createUpdaterArtifacts: true` 会自动生成 `.sig`；签名由第 2 步的环境变量驱动。

## 3. 生成 latest.json

字段说明（Tauri v2 静态更新源格式）：

```json
{
  "version": "1.2.0",
  "notes": "修复 xxx；新增 yyy",
  "pub_date": "2026-11-06T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<.sig 文件的完整内容>",
      "url": "https://xichengli.cloud/lshell/Lshell_1.2.0_x64-setup.exe"
    }
  }
}
```

- `version` 必须大于客户端当前版本，否则不会提示更新。
- `signature` 是 `.sig` 文件全文（单行），不是路径。
- `url` 必须指向可匿名下载的 HTTPS 地址，并与实际上传文件名一致。
- 上传顺序：先传安装包，再传 `latest.json`，避免客户端读到新清单却下载 404。

## 4. 发布后验证

1. 浏览器打开 `https://xichengli.cloud/lshell/latest.json`，确认 JSON 可访问且版本号正确。
2. 用上一版客户端启动，等待 30 秒或手动点「检查更新」。
3. 确认弹出的版本号、更新说明正确；点「下载更新」观察进度与签名校验。
4. 点「重启以完成更新」，确认 NSIS 安装器完成安装并重新启动新版本。
5. 若失败：
   - `signature` 与安装包不匹配 → 更新包会校验失败，不会安装；
   - `latest.json` 版本未提升 → 客户端认为已是最新；
   - 地址 404 → 只提示网络错误，不影响现有会话。

## 5. 打包与兼容性说明

- **主用 NSIS**：`bundle.targets` 已改为 `["nsis"]`，updater 依赖 NSIS 安装包。
- **MSI 老用户迁移**：MSI 与 NSIS 是两种独立安装方式，不能原地升级。
  MSI 用户需要先卸载旧版（主机库与凭据在 `%APPDATA%/Lshell`，卸载不会删除数据），
  再安装 NSIS 版本；之后即可接收自动更新。发布说明里应写清这一点。
- **WebView2**：当前使用 Tauri 默认的 bootstrapper（安装时按需联网下载运行时），
  不内置约 130MB 的离线包。若将来需要内网离线安装，可改为
  `bundle.windows.webviewInstallMode = { "type": "offlineInstaller" }` 并随包附带
  对应版本的 WebView2 安装器；这会显著增大安装包体积，届时单独发布离线版即可。
