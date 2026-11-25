/* ============================================================
   Lshell 官网 —— 计数存储（SQLite）
   ------------------------------------------------------------
   用 Node 22 内置的 node:sqlite，无需任何第三方依赖。
   数据落在 website/data/stats.db，直接用 sqlite3 命令行即可查。

   表结构：
     visits(id, ts, path, referrer, ua_hash, ip_hash)
       —— 每次页面访问一行；ip_hash 用于算 UV（不存原始 IP）
     downloads(id, ts, file, ua_hash, ip_hash)
       —— 每次真实下载一行

   累计值（PV / UV / 下载数）在查询时实时聚合，
   避免维护两份可能不一致的计数器。
   ============================================================ */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "stats.db");

let db = null;

/** 打开数据库（惰性初始化，失败时降级为内存库，网站仍可访问） */
function open() {
  if (db) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS visits (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        path     TEXT    NOT NULL,
        referrer TEXT,
        ua_hash  TEXT,
        ip_hash  TEXT
      );
      CREATE TABLE IF NOT EXISTS downloads (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        file     TEXT    NOT NULL,
        ua_hash  TEXT,
        ip_hash  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_visits_ts   ON visits(ts);
      CREATE INDEX IF NOT EXISTS idx_visits_ip   ON visits(ip_hash);
      CREATE INDEX IF NOT EXISTS idx_downloads_ts ON downloads(ts);
    `);
  } catch (err) {
    console.error("[stats] 数据库打开失败，降级为内存存储：", err.message);
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        path TEXT NOT NULL, referrer TEXT, ua_hash TEXT, ip_hash TEXT);
      CREATE TABLE downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        file TEXT NOT NULL, ua_hash TEXT, ip_hash TEXT);
    `);
  }
  return db;
}

/**
 * 生成不可逆的哈希标识。
 * 加盐是为了避免彩虹表反查；不保存原始 IP，只留哈希。
 */
function hash(value, salt) {
  if (!value) return null;
  return crypto
    .createHash("sha256")
    .update(salt + "|" + value)
    .digest("hex")
    .slice(0, 32);
}

const SALT =
  process.env.LSHELL_STATS_SALT || "lshell-website-default-salt";

/** 记录一次页面访问 */
function recordVisit({ path: reqPath, referrer, userAgent, ip }) {
  const d = open();
  d.prepare(
    "INSERT INTO visits (ts, path, referrer, ua_hash, ip_hash) VALUES (?, ?, ?, ?, ?)"
  ).run(
    Date.now(),
    reqPath || "/",
    referrer || null,
    hash(userAgent, SALT),
    hash(ip, SALT)
  );
}

/** 记录一次下载 */
function recordDownload({ file, userAgent, ip }) {
  const d = open();
  d.prepare(
    "INSERT INTO downloads (ts, file, ua_hash, ip_hash) VALUES (?, ?, ?, ?)"
  ).run(Date.now(), file, hash(userAgent, SALT), hash(ip, SALT));
}

/**
 * 汇总统计。
 * PV  = 页面访问总次数
 * UV  = 去重访客数（按 ip_hash 去重）
 * Dl  = 下载总次数
 * DlU = 去重下载人数
 */
function stats() {
  const d = open();
  const one = (sql) => {
    const row = d.prepare(sql).get();
    return row ? Number(Object.values(row)[0]) : 0;
  };
  return {
    visitors: one("SELECT COUNT(DISTINCT ip_hash) FROM visits"),
    pageviews: one("SELECT COUNT(*) FROM visits"),
    downloads: one("SELECT COUNT(*) FROM downloads"),
    downloadUsers: one("SELECT COUNT(DISTINCT ip_hash) FROM downloads"),
    updatedAt: new Date().toISOString(),
  };
}

/** 关闭数据库（进程退出时调用） */
function close() {
  if (db) {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
    db = null;
  }
}

module.exports = { open, recordVisit, recordDownload, stats, close, DB_PATH };
