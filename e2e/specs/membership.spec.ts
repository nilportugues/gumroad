import { logIn, logInAsSeededSeller } from "../support/auth";
import { completeFreeCheckout, openProduct, removeOtherCartItems, startCheckout } from "../support/buyer";
import { SEED, uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";
import { createProduct, publishProduct } from "../support/seller";

test.describe("free membership", () => {
  test("a buyer subscribes, sees it in the library and cancels it", async ({ page, browser }) => {
    await logInAsSeededSeller(page);
    const name = `E2E member ${uniqueSuffix()}`;
    const permalink = await createProduct(page, { name, priceDollars: 0, type: "Membership" });
    await publishProduct(page, permalink);

    const buyerContext = await browser.newContext();
    const buyer = await buyerContext.newPage();
    await logIn(buyer, SEED.buyerEmail, SEED.sellerPassword);
    await openProduct(buyer, permalink);
    await startCheckout(buyer, permalink);
    await removeOtherCartItems(buyer, name);
    await completeFreeCheckout(buyer);
    await expect(buyer.getByText(name).first()).toBeVisible();

    await buyer.goto("/library");
    await buyer.getByRole("tab", { name: "Subscriptions" }).click();
    await expect(buyer.getByText(name).first()).toBeVisible();
    await buyer.getByRole("link", { name: `Manage membership for ${name} - Untitled` }).click();

    await buyer.getByRole("button", { name: /^Cancel membership$/u }).click();
    await expect(buyer.getByRole("button", { name: "Restart membership" })).toBeVisible();
    await expect(buyer.getByRole("button", { name: "Cancel membership" })).toBeHidden();
    await buyerContext.close();
  });
});
