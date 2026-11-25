/* ============================================================
   Lshell 官网 —— 交互脚本
   ------------------------------------------------------------
   动效原则：柔和适度。
   滚动渐显 + 悬停浮起（CSS 负责）+ 这里补 JS 独有的部分：
   导航滚动态、鼠标光晕、数字滚动、FAQ 折叠、统计拉取。
   ============================================================ */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------
     1. 导航滚动态
     --------------------------------------------------------- */
  var nav = document.getElementById("nav");
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("scrolled", window.scrollY > 12);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------------------------------------------------------
     2. 移动端菜单
     --------------------------------------------------------- */
  var toggle = document.getElementById("navToggle");
  var navLinks = document.querySelector(".nav-links");
  if (toggle && navLinks) {
    toggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    navLinks.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        navLinks.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------------------------------------------------------
     3. 滚动渐显
     --------------------------------------------------------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));

  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) {
      el.classList.add("in");
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------------------------------------------------------
     4. Hero 光晕跟随鼠标
     --------------------------------------------------------- */
  var hero = document.querySelector(".hero");
  var glow = document.getElementById("heroGlow");
  if (hero && glow && !reduceMotion) {
    var raf = 0;
    hero.addEventListener(
      "pointermove",
      function (e) {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          var r = hero.getBoundingClientRect();
          glow.style.left = e.clientX - r.left + "px";
          glow.style.top = e.clientY - r.top + "px";
          glow.classList.add("on");
          raf = 0;
        });
      },
      { passive: true }
    );
    hero.addEventListener("pointerleave", function () {
      glow.classList.remove("on");
    });
  }

  /* ---------------------------------------------------------
     5. FAQ 折叠
     --------------------------------------------------------- */
  document.querySelectorAll(".faq-item").forEach(function (item) {
    var q = item.querySelector(".faq-q");
    var a = item.querySelector(".faq-a");
    if (!q || !a) return;

    q.addEventListener("click", function () {
      var isOpen = item.classList.contains("open");

      // 手风琴：同时只开一个
      document.querySelectorAll(".faq-item.open").forEach(function (other) {
        if (other === item) return;
        other.classList.remove("open");
        other.querySelector(".faq-q").setAttribute("aria-expanded", "false");
        other.querySelector(".faq-a").style.maxHeight = null;
      });

      if (isOpen) {
        item.classList.remove("open");
        q.setAttribute("aria-expanded", "false");
        a.style.maxHeight = null;
      } else {
        item.classList.add("open");
        q.setAttribute("aria-expanded", "true");
        a.style.maxHeight = a.scrollHeight + "px";
      }
    });
  });

  // 窗口尺寸变化时重算已展开项的高度
  window.addEventListener(
    "resize",
    function () {
      document.querySelectorAll(".faq-item.open .faq-a").forEach(function (a) {
        a.style.maxHeight = a.scrollHeight + "px";
      });
    },
    { passive: true }
  );

  /* ---------------------------------------------------------
     6. 数字滚动
     --------------------------------------------------------- */
  function animateCount(el, target) {
    if (reduceMotion) {
      el.textContent = target.toLocaleString("en-US");
      return;
    }
    var dur = 1100;
    var start = null;

    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      // easeOutCubic
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString("en-US");
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---------------------------------------------------------
     7. 统计数字
     --------------------------------------------------------- */
  var statVisitors = document.getElementById("statVisitors");
  var statDownloads = document.getElementById("statDownloads");

  function fillStats(stats) {
    if (statVisitors && typeof stats.visitors === "number") {
      animateCount(statVisitors, stats.visitors);
    }
    if (statDownloads && typeof stats.downloads === "number") {
      animateCount(statDownloads, stats.downloads);
    }
  }

  if (statVisitors || statDownloads) {
    fetch("/api/stats", { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(fillStats)
      .catch(function () {
        // 服务未启动时静默降级，保留占位符
        if (statVisitors) statVisitors.textContent = "—";
        if (statDownloads) statDownloads.textContent = "—";
      });
  }

  /* ---------------------------------------------------------
     8. 下载点击埋点（服务端已在代理层计数，这里只做前端兜底）
     --------------------------------------------------------- */
  document.querySelectorAll("[data-dl]").forEach(function (el) {
    el.addEventListener("click", function () {
      // 真实计数发生在 /api/download 代理层；此处仅用于
      // 静态托管（无后端）场景的降级上报。
      if (!window.__LSHELL_API__) {
        var url = "/api/track?type=download&file=" + encodeURIComponent(el.dataset.dl);
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url);
        }
      }
    });
  });
})();
