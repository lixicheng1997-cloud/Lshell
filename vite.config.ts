import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    // 工作区里 src/ 与 node_modules/ 是指向真实目录的 junction。
    // vite 默认把模块解析成真实路径（盘外），落在项目根之外会被
    // server.fs 拦截，导致模块以未转译的原始 TS 返回、页面空白。
    // 保留符号链接路径，让解析结果始终停留在工作区内。
    preserveSymlinks: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
