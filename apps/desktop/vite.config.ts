import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keeps Rust build errors from Tauri on screen instead of clearing them.
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    // Must match devUrl in src-tauri/tauri.conf.json. strictPort fails rather than
    // moving to another port that Tauri would not load.
    port: 1420,
    strictPort: true,
    // Rust changes rebuild through Tauri, so Vite should not reload for them.
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
