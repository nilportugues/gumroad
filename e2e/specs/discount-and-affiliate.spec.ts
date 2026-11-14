import { logInAsSeededSeller, signUp } from "../support/auth";
import { uniqueEmail, uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";
import { addAffiliate } from "../support/seller";

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
    await page.getByRole("combobox", { name: "Products" }).click();
    await page.getByRole("option", { name: "Beautiful widget", exact: true }).click();
    await page.getByRole("textbox", { name: "Percentage", exact: true }).fill("10");
    await page.getByRole("button", { name: "Add discount" }).click();
    await expect(page.getByText(code).first()).toBeVisible();
  });

  test("an affiliate is added by email", async ({ page, browser }) => {
    // A fresh account per run: an affiliate can be added once per seller, so reusing a seeded creator breaks the second run.
    const affiliateEmail = uniqueEmail("affiliate");
    const affiliate = await browser.newContext();
    await signUp(await affiliate.newPage(), affiliateEmail);
    await affiliate.close();

    await addAffiliate(page, { email: affiliateEmail, commissionPercent: 20 });
    await expect(page.getByRole("table").getByText(affiliateEmail).first()).toBeVisible();
  });
});
