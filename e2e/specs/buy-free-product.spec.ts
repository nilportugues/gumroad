import { signUp } from "../support/auth";
import { buyFreeProduct } from "../support/buyer";
import { SEED, uniqueEmail } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("buying the seeded free product", () => {
  test("a guest buys it with an email address and lands on the content page", async ({ page }) => {
    await buyFreeProduct(page, SEED.freeProductPermalink, { email: uniqueEmail("guest") });
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();
  });

  test("a signed-in buyer gets the receipt and finds the product in the library", async ({ page }) => {
    await signUp(page, uniqueEmail("buyer"));
    await buyFreeProduct(page, SEED.freeProductPermalink);
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();

    await page.goto("/library");
    await expect(page.getByText(SEED.freeProductName).first()).toBeVisible();
  });

  test("the receipt page renders for a purchase", async ({ page }) => {
    await buyFreeProduct(page, SEED.freeProductPermalink, { email: uniqueEmail("receipt") });
    const receiptLink = page.getByRole("link", { name: /receipt/i }).first();
    await expect(receiptLink).toBeVisible();
    await receiptLink.click();
    await expect(page.getByText(/receipt|order|\$0/i).first()).toBeVisible();
  });
});
