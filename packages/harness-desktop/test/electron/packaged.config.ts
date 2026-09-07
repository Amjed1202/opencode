import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "packaged.spec.ts",
  outputDir: "../../test-results/packaged",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: "list",
})
