import { SEED } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("seller profile", () => {
  test("the seeded seller's profile lists their products", async ({ page, baseURL }) => {
    const origin = new URL(baseURL!);
    await page.goto(`${origin.protocol}//${SEED.sellerUsername}.${origin.host}/`);
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();
  });

  test("a product page links back to the seller", async ({ page }) => {
    await page.goto(`/l/${SEED.freeProductPermalink}`);
    await expect(page.getByRole("heading", { name: SEED.freeProductName }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Seller" }).first()).toBeVisible();
  });
});
