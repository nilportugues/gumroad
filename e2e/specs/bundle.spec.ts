import { logIn, logInAsSeededSeller } from "../support/auth";
import { completeFreeCheckout, openProduct, removeOtherCartItems, startCheckout } from "../support/buyer";
import { SEED, uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("bundle", () => {
  test("a seller creates and publishes a bundle and a buyer buys it", async ({ page, browser }) => {
    await logInAsSeededSeller(page);
    const name = `E2E bundle ${uniqueSuffix()}`;
    await page.goto("/products/new");
    await page.getByRole("radio", { name: /Bundle/u }).click();
    const textInputs = page.locator("input[type=text]");
    await textInputs.first().fill(name);
    await textInputs.nth(1).fill("0");
    await page.getByRole("button", { name: /^Next: Customize$/u }).click();
    await page.waitForURL(/\/bundles\/[^/]+\/product\/edit/u, { timeout: 90_000 });

    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForURL(/\/bundles\/[^/]+\/content\/edit/u, { timeout: 60_000 });
    await page.getByRole("button", { name: "Add products" }).click();
    await page.getByRole("textbox", { name: "Search products" }).fill(SEED.freeProductName);
    await page.getByRole("checkbox", { name: SEED.freeProductName, exact: true }).first().check();
    await expect(page.getByRole("list", { name: "Bundle products" })).toContainText(SEED.freeProductName);

    await page.getByRole("button", { name: "Publish and continue" }).click();
    await page.waitForURL(/\/bundles\/[^/]+\/share\/edit/u, { timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible({ timeout: 60_000 });
    const url = await page
      .getByText(/\/l\/[a-z0-9]+/u)
      .first()
      .innerText();
    const permalink = url.replace(/\s/gu, "").split("/l/")[1] ?? "";
    expect(permalink).not.toBe("");

    const buyerContext = await browser.newContext();
    const buyer = await buyerContext.newPage();
    await logIn(buyer, SEED.buyerEmail, SEED.sellerPassword);
    await openProduct(buyer, permalink);
    await expect(buyer.getByRole("heading", { name }).first()).toBeVisible();
    await startCheckout(buyer, permalink);
    await removeOtherCartItems(buyer, name);
    await // A bundle purchase lands on the library filtered to the bundle, not on a content page.
    await completeFreeCheckout(buyer, { landing: /\/library\?bundles=/u });
    await expect(buyer.getByText(name).first()).toBeVisible();
    await buyerContext.close();
  });
});
