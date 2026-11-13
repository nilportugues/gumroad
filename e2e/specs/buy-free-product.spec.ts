import { logIn, signUp } from "../support/auth";
import { buyFreeProduct } from "../support/buyer";
import { SEED, uniqueEmail } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("buying the seeded free product", () => {
  test("a guest buys it with an email address and lands on the content page", async ({ page }) => {
    await buyFreeProduct(page, SEED.freeProductPermalink, { email: uniqueEmail("guest") });
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();
  });

  test("a signed-in buyer lands on the content page", async ({ page }) => {
    await signUp(page, uniqueEmail("buyer"));
    await buyFreeProduct(page, SEED.freeProductPermalink);
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();
  });

  test("the receipt page renders for a purchase", async ({ page }) => {
    await buyFreeProduct(page, SEED.freeProductPermalink, { email: uniqueEmail("receipt") });
    const receipt = page.locator('a[href*="/receipt"]').first();
    await expect(receipt).toBeVisible();
    await receipt.click();
    await expect(page).toHaveURL(/\/receipt/);
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();
  });
});

test.describe("library", () => {
  test("a buyer sees their purchases", async ({ page }) => {
    await logIn(page, SEED.libraryBuyerEmail, SEED.libraryBuyerPassword);
    await page.goto("/library");
    await expect(page.getByRole("heading", { name: "Library" }).first()).toBeVisible();
    await expect(page.getByText(SEED.libraryProductName).first()).toBeVisible();
  });

  test("a new unconfirmed account is sent to settings instead of the library", async ({ page }) => {
    await signUp(page, uniqueEmail("unconfirmed"));
    await page.goto("/library");
    await expect(page).toHaveURL(/\/settings/);
  });
});
