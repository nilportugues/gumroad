import { logInAsSeededSeller } from "../support/auth";
import { uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("discount codes and affiliates", () => {
  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
  });

  test("a discount code is created and listed", async ({ page }) => {
    const code = `E2E${uniqueSuffix()}`.toUpperCase();
    await page.goto("/checkout/discounts");
    await page.getByRole("button", { name: "New discount" }).first().click();
    await page.getByLabel("Name").fill(`E2E ${code}`);
    await page.getByLabel("Discount code").fill(code);
    await page.getByLabel("Percentage").fill("10");
    await page.getByRole("button", { name: "Add discount" }).click();
    await expect(page.getByText(code).first()).toBeVisible();
  });

  test("an affiliate is added by email", async ({ page }) => {
    await page.goto("/affiliates/new");
    await page.getByPlaceholder("Email of a Gumroad creator").fill("gumbo_film@gumroad.com");
    await page.getByRole("checkbox", { name: "Enable all products" }).check();
    await page.getByLabel("Commission").first().fill("20");
    await page.getByRole("button", { name: "Add affiliate" }).click();
    await expect(page).toHaveURL(/\/affiliates(\?|$)/);
    await expect(page.getByText("gumbo_film@gumroad.com").first()).toBeVisible();
  });
});
