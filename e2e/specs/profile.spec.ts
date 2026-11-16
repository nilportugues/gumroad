import { present } from "../support/assert";
import { SEED } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("seller profile", () => {
  test("the seeded seller's profile lists their products", async ({ page, baseURL }) => {
    const origin = new URL(present(baseURL, "baseURL"));
    await page.goto(`${origin.protocol}//${SEED.sellerUsername}.${origin.host}/`);
    // The seeded seller accumulates products across runs, so the profile may page past the seeded one.
    await expect(page.locator('a[href*="/l/"]').first()).toBeVisible();
  });

  test("a product page links back to the seller", async ({ page }) => {
    await page.goto(`/l/${SEED.freeProductPermalink}`);
    await expect(page.getByRole("heading", { name: SEED.freeProductName }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Seller" }).first()).toBeVisible();
  });
});
