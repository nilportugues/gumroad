import { logInAsSeededSeller } from "../support/auth";
import { uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";
import { createProduct, publishProduct } from "../support/seller";

test.describe("seller creates and publishes products", () => {
  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
  });

  test("a free product is created, published and visible to a logged-out buyer", async ({ page, browser }) => {
    const name = `E2E free ${uniqueSuffix()}`;
    const permalink = await createProduct(page, { name, priceDollars: 0 });
    await publishProduct(page, permalink);

    const buyer = await browser.newContext();
    const buyerPage = await buyer.newPage();
    await buyerPage.goto(`/l/${permalink}`);
    await expect(buyerPage.getByRole("heading", { name }).first()).toBeVisible();
    await expect(buyerPage.locator(`a[href*="/checkout?product=${permalink}"]`).first()).toBeAttached();
    await buyer.close();
  });

  test("a paid product shows its price on the product page", async ({ page, browser }) => {
    const name = `E2E paid ${uniqueSuffix()}`;
    const permalink = await createProduct(page, { name, priceDollars: 7 });
    await publishProduct(page, permalink);

    const buyer = await browser.newContext();
    const buyerPage = await buyer.newPage();
    await buyerPage.goto(`/l/${permalink}`);
    await expect(buyerPage.getByRole("heading", { name }).first()).toBeVisible();
    await expect(buyerPage.getByText("$7").first()).toBeVisible();
    await buyer.close();
  });

  test("the product list shows the new product", async ({ page }) => {
    const name = `E2E listed ${uniqueSuffix()}`;
    await createProduct(page, { name, priceDollars: 0 });
    await page.goto("/products");
    await expect(page.getByText(name).first()).toBeVisible();
  });
});
