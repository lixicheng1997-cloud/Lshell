/** 通过 CDP 模拟真实的鼠标操作：悬停、拖拽、点击 */
const PORT = process.env.CDP_PORT ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function findPage() {
  const res = await fetch(`${BASE}/json/list`);
  const targets = await res.json();
  return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
      on(method, handler) {
        ws.addEventListener("message", (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.method === method) handler(msg.params);
        });
      },
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
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);

  // 自动接受 confirm 对话框（删除操作会弹确认）
  cdp.on("Page.javascriptDialogOpening", async (params) => {
    console.log("对话框:", params.message.replace(/\n/g, " / "));
    await cdp.send("Page.handleJavaScriptDialog", { accept: true });
  });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails.exception));
    return result.value;
  };

  const mouse = (type, x, y, button = "none", clickCount = 0) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button,
      buttons: button === "left" && type !== "mouseReleased" ? 1 : 0,
      clickCount,
    });

  const rect = async (selector) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);

  const shot = async (file) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log("截图:", file);
  };

  const steps = process.argv.slice(2);

  for (const step of steps) {
    if (step.startsWith("hover:")) {
      const sel = step.slice(6);
      const r = await rect(sel);
      if (!r) {
        console.log(`找不到元素 ${sel}`);
        continue;
      }
      await mouse("mouseMoved", r.x, r.y);
      await sleep(350);
      console.log(`悬停 ${sel} →`, JSON.stringify(await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        const acts = el.querySelector(".row-actions");
        return acts ? { opacity: getComputedStyle(acts).opacity, buttons: acts.querySelectorAll("button").length } : null;
      })()`)));
    } else if (step.startsWith("drag:")) {
      const [sel, dxStr] = step.slice(5).split("|");
      const dx = Number(dxStr ?? 60);
      const r = await rect(sel);
      if (!r) {
        console.log(`找不到元素 ${sel}`);
        continue;
      }
      const before = await evaluate(`document.querySelector(".sidebar").getBoundingClientRect().width`);
      // rect() 返回的 x 已经是元素中心，避免落在相邻栏的边界像素上
      const cx = r.x;
      await mouse("mouseMoved", cx, r.y);
      await mouse("mousePressed", cx, r.y, "left", 1);
      for (let i = 1; i <= 8; i++) {
        await mouse("mouseMoved", cx + (dx * i) / 8, r.y, "left");
        await sleep(30);
      }
      await mouse("mouseReleased", cx + dx, r.y, "left", 1);
      await sleep(300);
      const after = await evaluate(`document.querySelector(".sidebar").getBoundingClientRect().width`);
      console.log(`拖拽 ${sel}：侧栏宽度 ${before} → ${after}`);
    } else if (step.startsWith("click:")) {
      const sel = step.slice(6);
      const r = await rect(sel);
      if (!r) {
        console.log(`找不到元素 ${sel}`);
        continue;
      }
      await mouse("mouseMoved", r.x, r.y);
      await mouse("mousePressed", r.x, r.y, "left", 1);
      await mouse("mouseReleased", r.x, r.y, "left", 1);
      await sleep(400);
      console.log(`点击 ${sel}`);
    } else if (step.startsWith("pseudo:")) {
      // CSS.forcePseudoState：CDP 派发的鼠标事件不会更新 :hover 状态，
      // 这里直接强制伪类，用来验证悬停样式
      const [sel, ...classes] = step.slice(7).split("|");
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: sel,
      });
      if (!nodeId) {
        console.log(`找不到元素 ${sel}（root=${root.nodeId}）`);
        continue;
      }
      await cdp.send("CSS.enable");
      await cdp.send("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: classes.length ? classes : ["hover"],
      });
      await sleep(250);
      console.log(
        `强制伪类 ${sel} →`,
        JSON.stringify(
          await evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            const acts = el.querySelector(".row-actions");
            return acts ? { opacity: getComputedStyle(acts).opacity, buttons: acts.querySelectorAll("button").length } : null;
          })()`)
        )
      );
    } else if (step.startsWith("eval:")) {
      console.log("eval →", JSON.stringify(await evaluate(step.slice(5))));
    } else if (step.startsWith("shot:")) {
      await shot(step.slice(5));
    }
  }

  cdp.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
