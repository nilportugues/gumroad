import { defineConfig, devices } from "@playwright/test";

import { resolveBaseUrl } from "./e2e/support/base-url";

// Throws for any host that is not local or an example.* domain.
const baseURL = resolveBaseUrl();

// The default timeouts are generous: a cold development Rails server compiles on first hit.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.out/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.out/report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
  },
  projects: [
    // Pure unit checks: no app needed.
    { name: "guard", testMatch: /base-url-guard\.spec\.ts/u },
    // Fails fast, with instructions, when the app is down or not seeded.
    { name: "preflight", testMatch: /preflight\.setup\.ts/u },
    {
      name: "chromium",
      testDir: "./e2e/specs",
      testIgnore: /(base-url-guard\.spec|preflight\.setup|mobile-buyer\.spec)/u,
      dependencies: ["preflight"],
      use: { ...devices["Desktop Chrome"] },
    },
    // The buyer flows on a phone-sized viewport (touch, mobile user agent) in the same Chromium.
    {
      name: "mobile",
      testDir: "./e2e/specs",
      testMatch: /mobile-buyer\.spec\.ts/u,
      dependencies: ["preflight"],
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "bot",
      testDir: "./e2e/bot",
      testMatch: /bot\.bot\.ts/u,
      dependencies: ["preflight"],
      timeout: 0,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
