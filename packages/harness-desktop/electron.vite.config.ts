import { defineConfig } from "electron-vite"
import solid from "vite-plugin-solid"
import { resolve } from "node:path"

export default defineConfig({
  main: { build: { rollupOptions: { input: resolve("src/main/index.ts") } } },
  preload: {
    build: {
      rollupOptions: { input: resolve("src/preload/index.ts"), output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    root: "src/renderer",
    base: "./",
    plugins: [solid()],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
})
