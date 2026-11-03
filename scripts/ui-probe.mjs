/**
 * 通过 Chrome DevTools Protocol 检查运行中的 Tauri 应用。
 *
 * Tauri 的 WebView2 支持 `--remote-debugging-port`，启动时设置
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 即可开启。
 * 这样能拿到真实渲染后的界面截图，也能执行 JS 读取 DOM 状态。
 *
 * 用法：
 *   node scripts/ui-probe.mjs shot <输出png>
 *   node scripts/ui-probe.mjs eval "<js 表达式>"
 *   node scripts/ui-probe.mjs click "<css 选择器>"
 *   node scripts/ui-probe.mjs type "<css 选择器>" "<文本>"
 */

import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function findPage() {
  const res = await fetch(`${BASE}/json/list`);
  const targets = await res.json();
  const page = targets.find(
    (t) => t.type === "page" && t.webSocketDebuggerUrl
  );
  if (!page) {
    throw new Error(
      `未找到可调试的页面。targets=${JSON.stringify(
        targets.map((t) => ({ type: t.type, title: t.title }))
      )}`
    );
  }
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();

    ws.addEventListener("open", () => resolve(api));
    ws.addEventListener("error", (e) => reject(new Error(`WS 错误: ${e.message}`)));
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

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);

  try {
    if (cmd === "console") {
      // 抓取页面 console 输出
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify(window.__lshellConsole || [])`,
        returnByValue: true,
      });
      console.log(result.value);
    } else if (cmd === "buffer") {
      // 读取 xterm 缓冲区内容
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const t = window.__lshellTerm;
          if (!t) return "NO_TERM_INSTANCE";
          const b = t.buffer.active;
          const lines = [];
          for (let i = 0; i < b.length; i++) {
            const line = b.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          return lines.filter(l => l.trim()).slice(-30).join("\\n");
        })()`,
        returnByValue: true,
      });
      console.log(result.value);
    } else if (cmd === "shot") {
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      writeFileSync(args[0], Buffer.from(data, "base64"));
      console.log(`已保存 ${args[0]}`);
    } else if (cmd === "eval") {
      const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
        expression: args[0],
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) {
        console.error("执行异常:", JSON.stringify(exceptionDetails.exception));
        process.exitCode = 1;
      } else {
        console.log(
          typeof result.value === "object"
            ? JSON.stringify(result.value, null, 2)
            : String(result.value)
        );
      }
    } else if (cmd === "click") {
      await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(args[0])})?.click()`,
      });
      console.log(`已点击 ${args[0]}`);
    } else if (cmd === "type") {
      // React 受控输入：必须用原生 setter 改值，再派发 input 事件
      const [sel, text] = args;
      const js = `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        el.focus();
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return el.value === ${JSON.stringify(text)};
      })()`;
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: js,
        returnByValue: true,
      });
      console.log(result.value ? `已输入到 ${sel}` : `输入失败 ${sel}`);
    } else if (cmd === "send") {
      // 终端输入：xterm 监听 input 事件的 data 属性
      // 逐字符派发并留出间隔，模拟真实打字节奏
      const [sel, text] = args;
      const js = `(async () => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        el.focus();
        for (const ch of ${JSON.stringify(text)}) {
          el.dispatchEvent(new InputEvent("input", {
            data: ch, bubbles: true, cancelable: true, inputType: "insertText"
          }));
          await new Promise(r => setTimeout(r, 25));
        }
        return true;
      })()`;
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log(result.value ? `已发送到 ${sel}` : `未找到 ${sel}`);
    } else if (cmd === "key") {
      // 按键名，如 Enter / Tab / Escape
      const KEYS = {
        Enter: { code: "Enter", keyCode: 13, text: "\r" },
        Tab: { code: "Tab", keyCode: 9, text: "\t" },
        Escape: { code: "Escape", keyCode: 27, text: null },
        Backspace: { code: "Backspace", keyCode: 8, text: null },
      };
      const k = KEYS[args[0]];
      if (!k) {
        console.error(`不支持的按键: ${args[0]}`);
        process.exitCode = 1;
      } else {
        const sel = args[1] ?? ".xterm-helper-textarea";
        const js = `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return false;
          el.focus();
          el.dispatchEvent(new KeyboardEvent("keydown", {
            key: ${JSON.stringify(args[0])}, code: ${JSON.stringify(k.code)},
            keyCode: ${k.keyCode}, which: ${k.keyCode}, bubbles: true, cancelable: true
          }));
          return true;
        })()`;
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: js,
          returnByValue: true,
        });
        console.log(result.value ? `已按下 ${args[0]}` : `未找到 ${sel}`);
      }
    } else {
      console.error("用法: shot|eval|click|type|send|key|buffer ...");
      process.exitCode = 1;
    }
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
