import { logInAsSeededSeller, signUp } from "../support/auth";
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
    // The receipt card is an anchor that is not always laid out; follow its href.
    const href = await page.locator('a[href*="/receipt"]').first().getAttribute("href");
    await page.goto(href!);
    await expect(page).toHaveURL(/\/receipt/);
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();
  });
});

test.describe("library", () => {
  test("the seeded seller's library lists their seeded purchases", async ({ page }) => {
    await logInAsSeededSeller(page);
    await page.goto("/library");
    await expect(page.getByRole("heading", { name: "Library" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Open product action menu" }).first()).toBeVisible();
  });

  test("a new unconfirmed account is sent to settings instead of the library", async ({ page }) => {
    await signUp(page, uniqueEmail("unconfirmed"));
    await page.goto("/library");
    await expect(page).toHaveURL(/\/settings/);
  });
});
