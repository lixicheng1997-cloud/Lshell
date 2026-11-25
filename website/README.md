# Lshell 官网

多文件静态站 + 自建 Node 计数服务。零第三方依赖，只用 Node 内置模块。

## 目录结构

```
website/
├── index.html              页面主体（单页，8 个区块）
├── css/
│   ├── tokens.css          设计变量（配色 / 圆角 / 阴影 / 字体 / 动效）
│   ├── fonts.css           内置等宽中文字体的 @font-face 声明
│   ├── base.css            重置、排版、滚动渐显
│   ├── components.css      按钮、卡片、导航、FAQ、页脚等通用组件
│   └── sections.css        各区块专属样式（Hero / 画廊 / 时间线等）
├── js/
│   ├── main.js             滚动渐显、导航态、光晕跟随、数字滚动、FAQ、统计拉取
│   └── theme-gallery.js    10 套主题画廊的实时换装
├── assets/
│   ├── brand/              品牌标识 SVG
│   ├── fonts/              两款内置等宽中文字体（woff2）+ OFL 许可
│   └── img/                8 张主题插画
├── downloads/              待发布的安装包
├── data/                   SQLite 数据文件（运行时生成）
└── server/
    ├── server.js           HTTP 服务：静态托管 + 计数接口 + 下载代理
    ├── db.js               SQLite 存储层（node:sqlite）
    ├── stats-cli.js        统计查询命令行工具
    └── package.json
```

## 启动

```bash
cd website
node server/server.js
```

默认监听 `http://localhost:8080`。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LSHELL_STATS_SALT` | 内置默认值 | 统计哈希盐值，**生产环境必须改成随机串** |
| `NODE_OPTIONS` | — | 需要 `--experimental-sqlite`（Node 22.5~22.x 需要；Node 23.4+ 已转正） |

## 计数机制

数据落在 `website/data/stats.db`，用 `sqlite3` 命令行即可直接查。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/stats` | GET | 只读统计：UV / PV / 下载数 / 下载人数 |
| `/api/download?file=nsis` | GET | **下载代理**：先计数，再吐出安装包文件 |
| `/api/track?type=download&file=xxx` | GET | 兜底埋点（静态托管、无后端时用） |

**下载计数发生在代理层**，统计的是真实下载，不是按钮点击数。
访客去重按 `ip_hash`（加盐 SHA-256），**不存原始 IP**。

### 查询统计

```bash
node server/stats-cli.js              # 概览
node server/stats-cli.js --daily      # 按天明细
node server/stats-cli.js --files      # 按安装包明细
node server/stats-cli.js --recent 20  # 最近 20 条下载记录
```

## 部署

官网主体是纯静态文件，扔到任何静态托管都能跑（GitHub Pages、Nginx、Caddy 等）。
但要启用**真实下载计数**，必须让 `/api/download` 走本服务，不能直接把
`downloads/` 目录暴露出去。

### systemd 示例

```ini
[Unit]
Description=Lshell Website
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/lshell-website
Environment=PORT=8080
Environment=LSHELL_STATS_SALT=<改成随机串>
ExecStart=/usr/bin/node server/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

反向代理（Nginx）：

```nginx
server {
  listen 443 ssl http2;
  server_name lshell.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

`X-Forwarded-For` 必须透传，否则访客去重会把所有人算成同一个 IP。

## 发布新版本

1. 打包应用：`./scripts/build.sh`
2. 把新安装包放进 `website/downloads/`，同步更新 `server/server.js` 里
   `FILES` 白名单的**文件名与版本号**
3. 更新 `index.html` 中的版本号、体积数据、下载参数表
4. 同步更新 README 的安装包体积

## 内容维护点

| 要改什么 | 改哪里 |
|---|---|
| 配色 / 圆角 / 阴影 | `css/tokens.css` |
| 主题画廊的色板 | `js/theme-gallery.js` 里的 `THEMES` 数组 |
| 能力卡片文案 | `index.html` 的 `#features` 区块 |
| 版本历史 | `index.html` 的 `#changelog` 区块 |
| 路线图 | `index.html` 的 `#changelog` 区块内 `.roadmap` |
| FAQ | `index.html` 的 `#faq` 区块 |

主题画廊的色板与应用内 `src/lib/app-themes.ts` 同源，改主题时两处要一起改。

## 视觉验证

```bash
node scripts/shot-web.mjs .screenshots/web
```

用 CDP 驱动 Edge，在 9 个滚动位置各截一张图，同时输出页面状态
（滚动高度、reveal 数量、主题数、统计数字、字体加载状态）。
