import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const dataDir = join(tmpdir(), `istra-playwright-${process.pid}`);
process.env.ISTRA_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: "./src/web/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  globalTeardown: "./src/web/e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm build && exec node dist/server.js",
    env: { ...process.env, ISTRA_DATA_DIR: dataDir },
    url: "http://127.0.0.1:4317",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
