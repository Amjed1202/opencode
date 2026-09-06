import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  outputDir: "../../test-results/electron",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: "list",
})
