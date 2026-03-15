import { defineConfig } from "vite"
import appPlugin from "@rendesk/app/vite"

export default defineConfig({
  base: "./",
  plugins: [appPlugin],
  publicDir: "../app/public",
  clearScreen: false,
  esbuild: {
    keepNames: true,
  },
  build: {
    outDir: "dist/renderer",
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
})
