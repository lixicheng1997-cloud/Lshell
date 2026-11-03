/**
 * 捕获运行中页面的未处理异常。
 *
 * ui-probe 的 eval 走的是 Runtime.evaluate，一旦页面里的异常
 * 冒泡到顶层，React 会卸载整棵树，之后再 eval 什么都看不到 ——
 * 现场就没了。这个脚本在触发操作**之前**就挂上监听，
 * 把异常原样记录下来。
 *
 * 用法：node scripts/ui-errors.mjs "<js 表达式>"
 */

const PORT = process.env.CDP_PORT ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function findPage() {
  const res = await fetch(`${BASE}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("未找到可调试的页面");
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];

    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        events,
        close: () => ws.close(),
      })
    );
    ws.addEventListener("error", (e) => reject(new Error(`WS 错误: ${e.message}`)));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
  });
}

/** 把 CDP 事件的描述抽成人能读的文本 */
function describe(event) {
  const out = [];
  if (event.method === "Runtime.exceptionThrown") {
    const d = event.params.exceptionDetails;
    out.push(`[异常] ${d.text}`);
    if (d.exception?.description) out.push(d.exception.description);
    if (d.stackTrace?.callFrames?.length) {
      out.push(
        d.stackTrace.callFrames
          .slice(0, 12)
          .map(
            (f) =>
              `    at ${f.functionName || "<匿名>"} (${f.url}:${f.lineNumber}:${f.columnNumber})`
          )
          .join("\n")
      );
    }
  } else if (event.method === "Runtime.consoleAPICalled") {
    const args = event.params.args
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "?")
      .join(" ");
    out.push(`[console.${event.params.type}] ${args}`);
  } else if (event.method === "Log.entryAdded") {
    const e = event.params.entry;
    out.push(`[log.${e.level}] ${e.text}`);
  }
  return out.join("\n");
}

async function main() {
  const expr = process.argv[2] ?? "1";
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);

  try {
    // 先订阅，再触发
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });

    // 给异步异常一点时间冒泡
    await new Promise((r) => setTimeout(r, 1200));

    console.log("=== 返回值 ===");
    console.log(
      typeof result?.value === "object"
        ? JSON.stringify(result.value, null, 2)
        : String(result?.value)
    );
    if (exceptionDetails) {
      console.log("=== eval 异常 ===");
      console.log(JSON.stringify(exceptionDetails.exception, null, 2));
    }

    const lines = cdp.events.map(describe).filter(Boolean);
    if (lines.length) {
      console.log("=== 页面事件 ===");
      console.log(lines.join("\n"));
    } else {
      console.log("=== 页面事件：无 ===");
    }
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exitCode = 1;
});
