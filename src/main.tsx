import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";

/**
 * 全局屏蔽 WebView2 / 浏览器的默认右键菜单。
 *
 * 用捕获阶段只调用 preventDefault：不 stopPropagation，所以终端右键粘贴
 * （TerminalView 的 contextmenu 监听）和主机右键「复制主机」
 * （Sidebar 的 onContextMenu）仍会照常执行，只是不再弹出系统菜单。
 * 覆盖终端、侧栏、SFTP、输入框、设置弹层和空白处。
 */
window.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
  },
  true
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
