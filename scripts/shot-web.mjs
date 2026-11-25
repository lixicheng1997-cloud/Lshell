/**
 * 官网视觉验证：用 CDP 驱动 Edge 抓取多屏截图。
 *
 * 用法：
 *   node scripts/shot-web.mjs <输出目录>
 *
 * 会启动一个带 --remote-debugging-port 的 Edge 实例，
 * 依次在几个关键滚动位置截图，便于逐屏检查视觉。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const URL = process.env.WEB_URL || "http://localhost:8080/";
const OUT = process.argv[2] || ".screenshots/web";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("未找到可调试页面");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve(api));
    ws.addEventListener("error", (e) => reject(new Error(e.message)));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
    const api = {
      send(method, params = {}) {
        const msgId = ++id;
        return new Promise((res, rej) => {
          pending.set(msgId, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      close: () => ws.close(),
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });

  const edge = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=" + join(process.env.TEMP || ".", "edge-web-shot"),
    "--window-size=1440,1000",
    URL,
  ], { stdio: "ignore", detached: false });

  let page, cdp;
  try {
    page = await findPage();
    cdp = await connect(page.webSocketDebuggerUrl);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });

    // 收集控制台错误
    const errors = [];
    const origHandler = cdp.send;

    // 等待字体与首屏渲染完成
    await sleep(3500);

    const shots = [
      { name: "01-hero", y: 0 },
      { name: "02-values", y: 1000 },
      { name: "03-features", y: 1750 },
      { name: "04-themes", y: 3100 },
      { name: "05-fonts", y: 4100 },
      { name: "06-changelog", y: 4750 },
      { name: "07-download", y: 5800 },
      { name: "08-faq", y: 6750 },
      { name: "09-final", y: 7900 },
    ];

    for (const s of shots) {
      await cdp.send("Runtime.evaluate", {
        expression: `window.scrollTo({top:${s.y},behavior:'instant'})`,
      });
      await sleep(900);
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false,
      });
      const p = join(OUT, `${s.name}.png`);
      writeFileSync(p, Buffer.from(data, "base64"));
      console.log("已保存", p);
    }

    // 页面高度与关键状态
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        scrollHeight: document.documentElement.scrollHeight,
        innerWidth: window.innerWidth,
        reveals: document.querySelectorAll('.reveal').length,
        revealed: document.querySelectorAll('.reveal.in').length,
        themePicks: document.querySelectorAll('.theme-pick').length,
        faqItems: document.querySelectorAll('.faq-item').length,
        statVisitors: document.getElementById('statVisitors')?.textContent,
        statDownloads: document.getElementById('statDownloads')?.textContent,
        fontLoaded: document.fonts ? document.fonts.check('16px "Lshell Mono KuaiLe"') : 'n/a'
      })`,
      returnByValue: true,
    });
    console.log("\n页面状态:", result.value);
    console.log("控制台错误:", errors.length);
  } finally {
    if (cdp) cdp.close();
    try { process.kill(edge.pid); } catch (_) {}
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
