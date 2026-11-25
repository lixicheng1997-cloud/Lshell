/* ============================================================
   Lshell 官网 —— 主题画廊
   ------------------------------------------------------------
   色板与应用内 src/lib/app-themes.ts 同源：
   每套主题同时决定界面色板与终端配色，切换时预览窗整体换装。
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 10 套主题（id / 名称 / 色板 / 插画） ---------- */
  var THEMES = [
    {
      id: "cloud-day",
      name: "云朵棉花糖 · 日云",
      family: "云朵棉花糖",
      mode: "light",
      bg: "#F7F3FF",
      panel: "#EEE8FC",
      surface: "#FFFFFF",
      fg: "#3B3358",
      accent: "#7B61D1",
      ok: "#3E9E79",
      info: "#4A8FC7",
      artwork: "assets/img/cloud-day.png",
    },
    {
      id: "cloud-night",
      name: "云朵棉花糖 · 夜云",
      family: "云朵棉花糖",
      mode: "dark",
      bg: "#1C1B2E",
      panel: "#26243C",
      surface: "#302E49",
      fg: "#EDE8FF",
      accent: "#B9A4FF",
      ok: "#8FE3C2",
      info: "#9BD8FF",
      artwork: "assets/img/cloud-night.png",
    },
    {
      id: "peach-day",
      name: "蜜桃奶盖 · 蜜桃日",
      family: "蜜桃奶盖",
      mode: "light",
      bg: "#FFF8F3",
      panel: "#FBEDE5",
      surface: "#FFFFFF",
      fg: "#4A332E",
      accent: "#D96F4E",
      ok: "#4D9A6A",
      info: "#4E86A8",
      artwork: "assets/img/peach-day.png",
    },
    {
      id: "peach-night",
      name: "蜜桃奶盖 · 蜜桃夜",
      family: "蜜桃奶盖",
      mode: "dark",
      bg: "#2A1F26",
      panel: "#352831",
      surface: "#42313C",
      fg: "#FFEDE8",
      accent: "#FFB39B",
      ok: "#A8DCB1",
      info: "#A8CBEA",
      artwork: "assets/img/peach-night.png",
    },
    {
      id: "starry-day",
      name: "星夜绘本 · 晨光",
      family: "星夜绘本",
      mode: "light",
      bg: "#F7F8FF",
      panel: "#ECEEFF",
      surface: "#FFFFFF",
      fg: "#36385E",
      accent: "#6B62C9",
      ok: "#438C6A",
      info: "#447FA6",
      artwork: "assets/img/starry-day.png",
    },
    {
      id: "starry-night",
      name: "星夜绘本 · 星夜",
      family: "星夜绘本",
      mode: "dark",
      bg: "#1B1B33",
      panel: "#23233F",
      surface: "#2E2E4C",
      fg: "#E8E6FF",
      accent: "#9C93FF",
      ok: "#83D6B0",
      info: "#8FCBE8",
      artwork: "assets/img/starry-night.png",
    },
    {
      id: "mint-day",
      name: "薄荷汽水 · 浅薄荷",
      family: "薄荷汽水",
      mode: "light",
      bg: "#F2FBF7",
      panel: "#E6F5EE",
      surface: "#FFFFFF",
      fg: "#26453A",
      accent: "#2E9E77",
      ok: "#4E9440",
      info: "#3B899C",
      artwork: "assets/img/mint-day.png",
    },
    {
      id: "mint-night",
      name: "薄荷汽水 · 深薄荷",
      family: "薄荷汽水",
      mode: "dark",
      bg: "#142622",
      panel: "#1C322C",
      surface: "#254037",
      fg: "#E4FFF4",
      accent: "#7EE0B8",
      ok: "#A6E86F",
      info: "#7CCBD9",
      artwork: "assets/img/mint-night.png",
    },
    {
      id: "pure-white",
      name: "素色 · 纯白",
      family: "素色",
      mode: "light",
      bg: "#FFFFFF",
      panel: "#FFFFFF",
      surface: "#FAFAFA",
      fg: "#0D0D0D",
      accent: "#141414",
      ok: "#2E7D4F",
      info: "#2A6FB0",
      artwork: null,
    },
    {
      id: "pure-black",
      name: "素色 · 纯黑",
      family: "素色",
      mode: "dark",
      bg: "#000000",
      panel: "#000000",
      surface: "#0D0D0D",
      fg: "#F5F5F5",
      accent: "#F0F0F0",
      ok: "#8FD9A8",
      info: "#9AC7F0",
      artwork: null,
    },
  ];

  var picker = document.getElementById("themePicker");
  var preview = document.getElementById("themePreview");
  var tpName = document.getElementById("tpName");
  var tpBadge = document.getElementById("tpBadge");
  var tpBar = document.getElementById("tpBar");
  var tpBody = document.getElementById("tpBody");
  var tpSideLeft = document.getElementById("tpSideLeft");
  var tpSideRight = document.getElementById("tpSideRight");
  var tpTerm = document.getElementById("tpTerm");
  var themeMeta = document.getElementById("themeMeta");

  if (!picker || !preview) return;

  /** hex → rgba()，用于把面板做成半透明浮层，让底下的插画透出来 */
  function alpha(hex, a) {
    var h = hex.replace("#", "");
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  /* ---------- 构造左侧选择列表 ---------- */
  var buttons = [];

  THEMES.forEach(function (t, i) {
    var btn = document.createElement("button");
    btn.className = "theme-pick";
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.dataset.index = String(i);

    btn.innerHTML =
      '<span class="theme-swatch">' +
      '<i style="background:' + t.bg + '"></i>' +
      '<i style="background:' + t.accent + '"></i>' +
      '<i style="background:' + t.panel + '"></i>' +
      "</span>" +
      '<span class="nm">' + t.name + "</span>" +
      '<span class="sub">' + (t.mode === "light" ? "浅色" : "深色") + "</span>";

    btn.addEventListener("click", function () {
      apply(t, i);
    });

    picker.appendChild(btn);
    buttons.push(btn);
  });

  /* ---------- 应用主题到预览窗 ---------- */
  function apply(t, index) {
    buttons.forEach(function (b, i) {
      var on = i === index;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });

    tpName.textContent = t.name;
    tpBadge.textContent = t.mode === "light" ? "浅色" : "深色";
    tpBadge.className = "badge " + (t.mode === "light" ? "chip-accent" : "chip-peach");

    // 用 CSS 变量驱动整窗换装
    preview.style.setProperty("--tp-bg", t.bg);
    preview.style.setProperty("--tp-panel", t.panel);
    preview.style.setProperty("--tp-surface", t.surface);
    preview.style.setProperty("--tp-fg", t.fg);
    preview.style.setProperty("--tp-accent", t.accent);
    preview.style.setProperty("--tp-ok", t.ok);
    preview.style.setProperty("--tp-info", t.info);

    tpBar.style.color = t.fg;
    tpBody.style.color = t.fg;

    /* ---------- 插画：铺在最外层，充当整窗底图 ----------
       插画必须挂在 preview 上，不能挂 tpBody ——
       tpBody 的子元素（左右侧栏、终端区）各有自己的背景，
       挂在内层会被完全遮住。

       材质规则与应用内一致（见 src/styles/components.css）：
         「终端容器与其他面板使用同一套半透明材质」
         .app.with-bg .term-host { background: var(--bg-panel-veil); }
       所以标题栏、左右侧栏、终端区共用同一个 VEIL 透明度，
       只有「选中项」用更实一层的 surface 色。 */
    var VEIL = 0.62;

    if (t.artwork) {
      // 浅色主题的插画本身很淡，压一层薄薄的主题色增强存在感；
      // 深色主题则压暗，避免亮色插画与深色底割裂。
      preview.style.backgroundImage =
        "linear-gradient(" +
        (t.mode === "dark"
          ? alpha(t.bg, 0.55)
          : alpha(t.surface, 0.18)) +
        "), url(" +
        t.artwork +
        ")";
      preview.style.backgroundSize = "cover";
      preview.style.backgroundPosition = "center";
      preview.style.backgroundColor = t.bg;

      // 所有面板共用同一套半透明材质，插画从底下均匀透出来
      tpBar.style.background = alpha(t.panel, VEIL);
      tpBar.style.borderBottom = "1px solid " + alpha(t.panel, 0.95);
      tpBody.style.backgroundColor = "transparent";
      [tpSideLeft, tpSideRight].forEach(function (side) {
        side.style.background = alpha(t.panel, VEIL);
        side.style.borderColor = alpha(t.panel, 0.9);
      });
      // 终端区与侧栏同材质，不再是完全透明
      tpTerm.style.background = alpha(t.panel, VEIL);
    } else {
      // 素色族无插画：还原为纯色实底
      preview.style.backgroundImage = "none";
      preview.style.backgroundColor = t.bg;
      tpBar.style.background = t.panel;
      tpBar.style.borderBottom = "1px solid " + t.panel;
      tpBody.style.backgroundColor = t.bg;
      [tpSideLeft, tpSideRight].forEach(function (side) {
        side.style.background = t.panel;
        side.style.borderColor = t.panel;
      });
      tpTerm.style.background = t.panel;
    }

    // 选中项用更实一层的 surface 色（对应应用内的 --bg-surface-veil）
    tpSideLeft.querySelector(".host.active").style.background = alpha(t.surface, 0.9);
    tpSideLeft.querySelector(".host.active").style.color = t.accent;
    tpTerm.style.color = t.fg;

    // 底部信息条
    if (themeMeta) {
      themeMeta.innerHTML =
        (t.artwork
          ? '<span class="chip chip-mint"><span class="dot" style="background:var(--mint)"></span>内置插画背景</span>'
          : '<span class="chip chip-sun">纯色底 · 不带插画</span>') +
        '<span class="chip">终端配色热切换</span>' +
        '<span class="chip">插画与面板浓度可独立调节</span>';
    }
  }

  // 默认选中第一套
  apply(THEMES[0], 0);

  /* ---------- 键盘左右切换 ---------- */
  picker.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    var cur = buttons.findIndex(function (b) {
      return b.classList.contains("active");
    });
    if (cur < 0) return;
    var next =
      e.key === "ArrowRight"
        ? (cur + 1) % buttons.length
        : (cur - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
    apply(THEMES[Number(buttons[next].dataset.index)], next);
    e.preventDefault();
  });
})();
