import { logInAsSeededSeller } from "../support/auth";
import { expect, test } from "../support/fixtures";

test.describe("seller dashboard and analytics", () => {
  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
  });

  test("the dashboard shows its activity, balance and earnings sections", async ({ page }) => {
    const response = await page.goto("/dashboard");
    expect(response?.status()).toBe(200);
    for (const name of ["Getting started", "Activity", "Balance", "Total earnings"]) {
      await expect(page.getByRole("heading", { name }).first()).toBeVisible();
    }
  });

  test("the analytics page loads its sales data from the analytics data endpoints", async ({ page }) => {
    const byDate = page.waitForResponse((response) => /\/analytics\/data\//u.test(response.url()));
    await page.goto("/analytics");
    await expect(page).toHaveURL(/\/dashboard\/sales/u);
    expect((await byDate).status()).toBe(200);
    for (const name of ["Analytics", "Sales", "Views", "Total"]) {
      await expect(page.getByRole("heading", { name }).first()).toBeVisible();
    }
  });
});
