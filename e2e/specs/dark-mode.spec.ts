import { type Page } from "@playwright/test";

import { openProduct, startCheckout } from "../support/buyer";
import { SEED } from "../support/env";
import { expect, test } from "../support/fixtures";

// The page paints from the first non-transparent background between <body> and <html>.
const backgroundLuminance = (page: Page) =>
  page.evaluate(() => {
    for (const element of [document.body, document.documentElement]) {
      const match = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/u.exec(getComputedStyle(element).backgroundColor);
      if (match && Number(match[4] ?? 1) > 0)
        return (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
    }
    return 1;
  });

// Discover follows the browser's color scheme. Product and checkout are served on the seller's subdomain with the
// seller's light theme and stay light today; a future dark theme there should flip `followsScheme`.
const PAGES = [
  { name: "discover", followsScheme: true, open: async (page: Page) => page.goto("/discover") },
  { name: "product", followsScheme: false, open: (page: Page) => openProduct(page, SEED.freeProductPermalink) },
  {
    name: "checkout",
    followsScheme: false,
    open: async (page: Page) => {
      await openProduct(page, SEED.freeProductPermalink);
      await startCheckout(page, SEED.freeProductPermalink);
    },
  },
];

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} color scheme`, () => {
    test.use({ colorScheme });

    for (const { name, open, followsScheme } of PAGES) {
      test(`${name} paints a ${followsScheme ? colorScheme : "light"} background in the ${colorScheme} scheme and a screenshot is attached`, async ({
        page,
      }, testInfo) => {
        await open(page);
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        const luminance = await backgroundLuminance(page);
        if (colorScheme === "dark" && followsScheme) expect(luminance).toBeLessThan(0.3);
        else expect(luminance).toBeGreaterThan(0.7);
        await testInfo.attach(`${name}-${colorScheme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      });
    }
  });
}
