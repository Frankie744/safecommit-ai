import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(
  process.env.SAFEFLASH_E2E_PORT ?? 31_000 + (process.pid % 10_000),
);
// Playwright evaluates this config again inside workers. Persist the selected
// port so every worker inherits the same URL as the web-server process.
process.env.SAFEFLASH_E2E_PORT = String(e2ePort);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "tests/e2e/report" }],
  ],
  outputDir: "tests/e2e/results",
  timeout: 30_000,
  expect: {
    timeout: 7_500,
  },
  use: {
    baseURL: e2eBaseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command:
      "npm run build --workspace @safeflash/web && npm run start --workspace @safeflash/web -- --hostname 127.0.0.1 --port " +
      String(e2ePort),
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SAFECOMMIT_OPERATOR_TOKEN: "safecommit-e2e-operator-token-123456",
      SAFECOMMIT_SOURCE_COMMIT_SHA:
        "0000000000000000000000000000000000000000",
    },
  },
  projects: [
    {
      name: "chrome-1440x900",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
