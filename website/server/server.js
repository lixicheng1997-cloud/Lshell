/* ============================================================
   Lshell 官网 —— 自建服务
   ------------------------------------------------------------
   职责：
     1. 托管 website/ 下的静态页面
     2. 记录页面访问（PV / UV）
     3. 代理下载安装包并在代理层计数（真实下载，不是点击数）
     4. 暴露只读统计接口 /api/stats

   启动：
     node server/server.js
   环境变量：
     PORT=8080                监听端口（默认 8080）
     HOST=0.0.0.0             监听地址（默认 0.0.0.0）
     LSHELL_STATS_SALT=xxx    统计哈希盐值（生产环境务必改）
     LSHELL_DOWNLOAD_BASE=    下载源站前缀（可选，留空则本地直接吐文件）

   零依赖：只用 Node 内置模块。
   ============================================================ */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const db = require("./db");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.join(__dirname, "..");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");

/* ---------- 可下载文件白名单 ---------- */
const FILES = {
  nsis: {
    path: path.join(DOWNLOAD_DIR, "Lshell_1.3.0_x64-setup.exe"),
    filename: "Lshell_1.3.0_x64-setup.exe",
    mime: "application/vnd.microsoft.portable-executable",
  },
};

/* ---------- 静态资源 MIME ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".html.gz": "text/html; charset=utf-8",
};

/* ---------- 工具 ---------- */
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) {
    return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** 安全地把 URL 路径映射到磁盘路径，防止 ../ 穿越 */
function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded.replace(/^\/+/, "");
  const abs = path.resolve(ROOT, rel);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}

/* ---------- 禁止静态访问的路径前缀 ----------
   服务端源码与统计数据库绝不能通过 HTTP 拿到：
   - server/  暴露 db.js / server.js 等实现细节
   - data/    stats.db 里有访客哈希与下载记录
   - 其余点文件（.env / .git 等）一并挡掉            */
const DENY_PREFIXES = ["server/", "data/"];

function isDenied(relPath) {
  const p = relPath.replace(/^\/+/, "").toLowerCase();
  if (DENY_PREFIXES.some((pre) => p.startsWith(pre))) return true;
  // 任何以点开头的路径段（.env / .git / .htaccess）
  if (p.split("/").some((seg) => seg.startsWith("."))) return true;
  return false;
}

/* ---------- 静态文件服务 ---------- */
function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;

  // 目录 → index.html
  const candidate = safeResolve(rel);
  if (!candidate) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  if (isDenied(rel)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  let target = candidate;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "index.html");
  }

  // 二次校验：解码后的真实落盘路径也不能落在禁区内
  // （防 URL 编码绕过，如 %2e%2e%2fserver%2fdb.js）
  const targetRel = path
    .relative(ROOT, target)
    .replace(/\\/g, "/")
    .toLowerCase();
  if (isDenied(targetRel)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // 回退到首页
    const home = path.join(ROOT, "index.html");
    if (fs.existsSync(home)) {
      target = home;
    } else {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
  }

  const ext = path.extname(target).toLowerCase();
  const stat = fs.statSync(target);
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304).end();
    return;
  }

  const isFont = ext === ".woff2" || ext === ".woff" || ext === ".ttf";
  const isImg = ext === ".png" || ext === ".jpg" || ext === ".webp" || ext === ".svg";

  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    ETag: etag,
    "Cache-Control": isFont
      ? "public, max-age=31536000, immutable"
      : isImg
      ? "public, max-age=604800"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(target).pipe(res);
}

/* ---------- 下载代理（计数发生在这里） ---------- */
function serveDownload(req, res, fileKey) {
  const meta = FILES[fileKey];
  if (!meta) {
    sendJson(res, 404, { error: "unknown file" });
    return;
  }
  if (!fs.existsSync(meta.path)) {
    sendJson(res, 404, {
      error: "file not ready",
      hint: "请先执行 tauri build 生成安装包",
    });
    return;
  }

  // —— 计数点：真实下载，不是点击 ——
  try {
    db.recordDownload({
      file: fileKey,
      userAgent: req.headers["user-agent"] || "",
      ip: clientIp(req),
    });
  } catch (err) {
    console.error("[stats] 下载计数失败：", err.message);
  }

  const stat = fs.statSync(meta.path);
  res.writeHead(200, {
    "Content-Type": meta.mime,
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${meta.filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(meta.path).pipe(res);
}

/* ---------- 主处理器 ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    // 只读统计接口
    if (pathname === "/api/stats") {
      sendJson(res, 200, db.stats());
      return;
    }

    // 兜底埋点（静态托管模式下前端调用）
    if (pathname === "/api/track") {
      const type = url.searchParams.get("type");
      if (type === "download") {
        db.recordDownload({
          file: url.searchParams.get("file") || "unknown",
          userAgent: req.headers["user-agent"] || "",
          ip: clientIp(req),
        });
      } else {
        db.recordVisit({
          path: url.searchParams.get("path") || "/",
          referrer: url.searchParams.get("ref") || "",
          userAgent: req.headers["user-agent"] || "",
          ip: clientIp(req),
        });
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // 下载代理
    if (pathname === "/api/download") {
      const file = url.searchParams.get("file") || "nsis";
      serveDownload(req, res, file);
      return;
    }

    // 页面访问计数：只对 HTML 文档记一次，避免 css/js 重复计
    if (req.method === "GET" && (pathname === "/" || pathname.endsWith(".html"))) {
      try {
        db.recordVisit({
          path: pathname,
          referrer: req.headers["referer"] || "",
          userAgent: req.headers["user-agent"] || "",
          ip: clientIp(req),
        });
      } catch (err) {
        console.error("[stats] 访问计数失败：", err.message);
      }
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    console.error("[server] 请求处理异常：", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("500 Internal Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Lshell 官网已启动`);
  console.log(`  ├─ 本地访问   http://localhost:${PORT}`);
  console.log(`  ├─ 静态目录   ${ROOT}`);
  console.log(`  └─ 数据文件   ${db.DB_PATH}\n`);
});

function shutdown() {
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
