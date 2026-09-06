import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

/** Browser visual inspection only: no bridge or provider transport is available in this preview. */
export default defineConfig({
  root: "src/renderer",
  plugins: [solid()],
  server: { host: "127.0.0.1", port: 4179, strictPort: true },
})
