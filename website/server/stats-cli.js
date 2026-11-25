/* ============================================================
   Lshell 官网 —— 统计查询 CLI
   ------------------------------------------------------------
   用法：
     node server/stats-cli.js              概览（PV / UV / 下载）
     node server/stats-cli.js --daily      按天明细
     node server/stats-cli.js --files      按安装包明细
     node server/stats-cli.js --recent 20  最近 20 条下载记录
   ============================================================ */

"use strict";

const db = require("./db");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const d = db.open();

function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - s.length));
}

const s = db.stats();

if (has("--daily")) {
  console.log("\n按天统计（最近 14 天）");
  console.log("─".repeat(58));
  console.log(pad("日期", 14) + pad("PV", 10) + pad("UV", 10) + "下载");
  const rows = d
    .prepare(
      `SELECT date(ts/1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS pv,
              COUNT(DISTINCT ip_hash) AS uv
       FROM visits
       WHERE ts > ? GROUP BY day ORDER BY day DESC LIMIT 14`
    )
    .all(Date.now() - 14 * 86400000);
  for (const r of rows) {
    const dl = d
      .prepare(
        `SELECT COUNT(*) AS c FROM downloads
         WHERE date(ts/1000, 'unixepoch', 'localtime') = ?`
      )
      .get(r.day);
    console.log(pad(r.day, 14) + pad(r.pv, 10) + pad(r.uv, 10) + (dl ? dl.c : 0));
  }
} else if (has("--files")) {
  console.log("\n按安装包统计");
  console.log("─".repeat(40));
  const rows = d
    .prepare(
      "SELECT file, COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u FROM downloads GROUP BY file"
    )
    .all();
  if (!rows.length) console.log("（暂无下载记录）");
  for (const r of rows) {
    console.log(pad(r.file, 20) + pad(r.c + " 次", 10) + r.u + " 人");
  }
} else if (has("--recent")) {
  const n = Number(valueOf("--recent", "20"));
  console.log(`\n最近 ${n} 条下载记录`);
  console.log("─".repeat(64));
  const rows = d
    .prepare(
      "SELECT ts, file, ip_hash FROM downloads ORDER BY ts DESC LIMIT ?"
    )
    .all(n);
  if (!rows.length) console.log("（暂无下载记录）");
  for (const r of rows) {
    const t = new Date(r.ts).toLocaleString("zh-CN");
    console.log(pad(t, 22) + pad(r.file, 26) + r.ip_hash);
  }
} else {
  console.log("\nLshell 官网统计概览");
  console.log("─".repeat(40));
  console.log(pad("访客数（UV）", 20) + s.visitors);
  console.log(pad("访问量（PV）", 20) + s.pageviews);
  console.log(pad("下载次数", 20) + s.downloads);
  console.log(pad("下载人数", 20) + s.downloadUsers);
  console.log(pad("数据文件", 20) + db.DB_PATH);
  console.log("");
}

db.close();
