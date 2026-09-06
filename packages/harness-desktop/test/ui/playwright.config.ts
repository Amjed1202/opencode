import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "renderer.spec.ts",
  outputDir: "../../test-results/renderer",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4179", viewport: { width: 1440, height: 1000 }, screenshot: "only-on-failure" },
  webServer: {
    command: "bun run preview:web",
    cwd: process.cwd(),
    url: "http://127.0.0.1:4179",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
