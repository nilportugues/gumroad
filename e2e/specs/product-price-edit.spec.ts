import { logInAsSeededSeller } from "../support/auth";
import { uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";
import { createProduct, publishProduct } from "../support/seller";

test.describe("seller edits a product price", () => {
  test("the product page and checkout follow a price change from $5 to $12", async ({ page, browser }) => {
    await logInAsSeededSeller(page);
    const name = `E2E repriced ${uniqueSuffix()}`;
    const permalink = await createProduct(page, { name, priceDollars: 5 });
    await publishProduct(page, permalink);

    const buyer = await browser.newContext();
    const buyerPage = await buyer.newPage();
    await buyerPage.goto(`/l/${permalink}`);
    await expect(buyerPage.getByText("$5").first()).toBeVisible();

    await page.goto(`/products/${permalink}/edit`);
    const amount = page.getByLabel("Amount", { exact: true });
    await expect(amount).toHaveValue("5");
    await amount.fill("12");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("toast-alert").getByText("Changes saved!")).toBeVisible();

    await buyerPage.reload();
    await expect(buyerPage.getByText("$12").first()).toBeVisible();

    await buyerPage.goto(`/checkout?product=${permalink}`);
    await expect(buyerPage.getByText("US$12").first()).toBeVisible();
    await buyer.close();
  });
});
