import { logInAsSeededSeller } from "../support/auth";
import { expect, test } from "../support/fixtures";

// Render only: nothing here reaches Stripe or PayPal.
test.describe("payouts and payment settings", () => {
  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
  });

  test("the payouts page lists past payouts", async ({ page }) => {
    const response = await page.goto("/payouts");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Payouts" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Past payouts" })).toBeVisible();
  });

  test("the payment settings page shows the payout schedule and method sections", async ({ page }) => {
    const response = await page.goto("/settings/payments");
    expect(response?.status()).toBe(200);
    // Matched by tag: a "Where are you located?" dialog hides the page from role queries until the country is set.
    await expect(page.locator("h2", { hasText: "Payout schedule" })).toBeVisible();
    await expect(page.locator("h2", { hasText: "Payout method" })).toBeVisible();
  });
});
