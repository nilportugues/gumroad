import { logInAsSeededSeller } from "../support/auth";
import { completeFreeCheckout } from "../support/buyer";
import { uniqueEmail, uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";
import { createDiscount, createProduct, publishProduct } from "../support/seller";

test.describe("discount code at checkout", () => {
  let permalink: string;
  let productName: string;
  let code: string;

  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
    productName = `E2E discounted ${uniqueSuffix()}`;
    permalink = await createProduct(page, { name: productName, priceDollars: 10 });
    await publishProduct(page, permalink);
    code = `E2E${uniqueSuffix()}`.toUpperCase();
  });

  test("a 25 percent code lowers the checkout total from $10 to $7.50", async ({ page, browser }) => {
    await createDiscount(page, { code, productName, percent: 25 });

    const buyer = await browser.newContext();
    const buyerPage = await buyer.newPage();
    await buyerPage.goto(`/checkout?product=${permalink}&code=${code}`);
    await expect(buyerPage.getByRole("heading", { name: "Checkout" })).toBeVisible();
    await expect(buyerPage.getByText("US$-2.50")).toBeVisible();
    await expect(buyerPage.getByText("US$7.50").first()).toBeVisible();
    await expect(buyerPage.getByText("Sorry, the discount code you wish to use is invalid.")).toHaveCount(0);
    await buyer.close();
  });

  test("an unknown code is rejected and the total stays at $10", async ({ browser }) => {
    const buyer = await browser.newContext();
    const buyerPage = await buyer.newPage();
    await buyerPage.goto(`/checkout?product=${permalink}&code=NOSUCHCODE${uniqueSuffix().toUpperCase()}`);
    await expect(buyerPage.getByText("Sorry, the discount code you wish to use is invalid.")).toBeVisible();
    await expect(buyerPage.getByText("US$10", { exact: false }).first()).toBeVisible();
    await expect(buyerPage.getByText("Discounts", { exact: true })).toHaveCount(0);
    await buyer.close();
  });

  test("a 100 percent code makes the paid product free to buy without a card", async ({ page, browser }) => {
    await createDiscount(page, { code, productName, percent: 100 });

    const buyer = await browser.newContext();
    const buyerPage = await buyer.newPage();
    await buyerPage.goto(`/checkout?product=${permalink}&code=${code}`);
    await expect(buyerPage.getByRole("heading", { name: "Checkout" })).toBeVisible();
    await completeFreeCheckout(buyerPage, { email: uniqueEmail("discount") });
    await expect(buyerPage.getByText(productName).first()).toBeVisible();
    await buyer.close();
  });
});
