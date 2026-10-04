import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  workers: 1,
  timeout: 45000,
  reporter: "list",
  outputDir: "test-results",
  use: { trace: "retain-on-failure" }
});
