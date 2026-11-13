import { defineConfig, devices } from "@playwright/test";

import { resolveBaseUrl } from "./e2e/support/base-url";
import { loadQuarantine, quarantinePatterns } from "./e2e/support/quarantine";

// Throws for any host that is not local or an example.* domain.
const baseURL = resolveBaseUrl();

// Quarantined specs (e2e/quarantine.json) leave the blocking `chromium` project and run in `quarantine`,
// which reports but is never part of `npm run e2e`.
const quarantined = quarantinePatterns(loadQuarantine("e2e/quarantine.json"));

// The default timeouts are generous: a cold development Rails server compiles on first hit.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.out/test-results",
  fullyParallel: false,
  workers: 1,
  // One retry locally, two in CI; E2E_RETRIES=0 turns it off. A spec that passes only on retry is flaky: see e2e/README.md.
  retries: Number(process.env.E2E_RETRIES ?? (process.env.CI ? 2 : 1)),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.out/report" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
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
      testIgnore: [/(base-url-guard\.spec|preflight\.setup)/u, ...quarantined],
      dependencies: ["preflight"],
      use: { ...devices["Desktop Chrome"] },
    },
    ...(quarantined.length > 0
      ? [
          {
            name: "quarantine",
            testDir: "./e2e/specs",
            testMatch: quarantined,
            dependencies: ["preflight"],
            retries: 0,
            use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" as const },
          },
        ]
      : []),
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
