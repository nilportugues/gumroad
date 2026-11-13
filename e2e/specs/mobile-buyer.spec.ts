import { buyFreeProduct } from "../support/buyer";
import { SEED, uniqueEmail } from "../support/env";
import { expect, test } from "../support/fixtures";

// Runs in the `mobile` project (Pixel 7); also valid on desktop. Headings and the page title move on a phone, so
// these assertions stick to text that stays in the page at every width.
test.describe("buyer flow on a phone", () => {
  test("the viewport is phone-sized", async ({ page }) => {
    await page.goto("/discover");
    expect(page.viewportSize()?.width).toBeLessThanOrEqual(500);
  });

  test("discover finds the seeded product by search", async ({ page }) => {
    await page.goto("/discover?query=widget");
    await expect(page.getByRole("heading", { name: /widget/iu }).first()).toBeVisible();
  });

  test("a guest buys the free product and reaches the content page", async ({ page }) => {
    await buyFreeProduct(page, SEED.freeProductPermalink, { email: uniqueEmail("mobile") });
    await expect(page).toHaveURL(/\/d\/[a-f0-9]+/u);
    await expect(page.locator("body")).toContainText(SEED.freeProductName);
  });
});
