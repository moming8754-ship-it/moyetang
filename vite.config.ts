import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // ⚠️ 下面三条是踩了两次坑之后加的（进度.md 第五节）：
      // 编辑器/工具写文件是"**临时目录 + 改名**"（比如 `.TreeNotePane.tsx.<pid>.<uuid>.tmpdir/TreeNotePane.tsx.tmp`），
      // vite 的 watcher 正扫到那个临时文件时会抛
      // `EBUSY: resource busy or locked, watch '…tmpdir\….tmp'` ——
      // **Node 的 fs.watch 抛在 error 事件上，整个 vite 进程直接退出**，
      // 表现是"改完前端文件，dev 悄悄死了，页面还在但拿到的全是旧代码"，
      // 非常容易把后面所有验证结论带偏（这次就骗了我好几轮）。
      // 忽略掉这些临时路径就行：真正的文件改名完成后还是会被正常监听到。
      ignored: [
        "**/src-tauri/**",
        "**/.*.tmpdir/**",
        "**/*.tmpdir/**",
        "**/.*.tmp",
        "**/*.tmp",
      ],
    },
  },
}));
