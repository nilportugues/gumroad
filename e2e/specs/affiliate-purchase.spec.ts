import { type Browser, type Page } from "@playwright/test";

import { present } from "../support/assert";
import { logInAsSeededSeller, signUp } from "../support/auth";
import { completeFreeCheckout, startCheckout } from "../support/buyer";
import { SEED, uniqueEmail } from "../support/env";
import { expect, test } from "../support/fixtures";
import { addAffiliate } from "../support/seller";

// The affiliate's referral link is /a/<numeric id>/<permalink>; the page only exposes it through its Inertia props.
const readReferralId = async (affiliatePage: Page) => {
  await affiliatePage.goto("/products/affiliated");
  await expect(affiliatePage.getByRole("button", { name: "Copy link" }).first()).toBeVisible();
  const props = await affiliatePage.evaluate(
    () =>
      document.querySelector("[data-page]")?.getAttribute("data-page") ??
      document.querySelector("script[data-page]")?.textContent ??
      "",
  );
  return present(
    new RegExp(`/a/(\\d+)/${SEED.freeProductPermalink}`, "u").exec(props)?.[1],
    "the affiliate referral id",
  );
};

/** Buys the free seeded product as a guest and returns the seller-side sale id from the receipt link. */
const buyAsGuest = async (browser: Browser, entryPath: string) => {
  const context = await browser.newContext();
  const buyer = await context.newPage();
  await buyer.goto(entryPath);
  await startCheckout(buyer, SEED.freeProductPermalink);
  await completeFreeCheckout(buyer, { email: uniqueEmail("affbuyer") });
  const receiptHref = await buyer.locator('a[href*="/receipt"]').first().getAttribute("href");
  await context.close();
  return present(/purchases\/([^/]+)\/receipt/u.exec(present(receiptHref, "the receipt link"))?.[1], "the sale id");
};

test.describe("affiliate link purchase", () => {
  let affiliateEmail: string;
  let referralId: string;

  test.beforeEach(async ({ page, browser }) => {
    affiliateEmail = uniqueEmail("affiliate");
    const affiliateContext = await browser.newContext();
    const affiliatePage = await affiliateContext.newPage();
    await signUp(affiliatePage, affiliateEmail);
    await logInAsSeededSeller(page);
    await addAffiliate(page, { email: affiliateEmail, commissionPercent: 20 });
    referralId = await readReferralId(affiliatePage);
    await affiliateContext.close();
  });

  test("a sale made through the affiliate link names the affiliate on the seller's sale page", async ({
    page,
    browser,
  }) => {
    const saleId = await buyAsGuest(browser, `/a/${referralId}/${SEED.freeProductPermalink}`);
    await page.goto(`/customers/sale/${saleId}`);
    await expect(page.getByText(`An affiliate (${affiliateEmail}) helped you make this sale`)).toBeVisible();
  });

  test("a sale made without the affiliate link has no affiliate on the seller's sale page", async ({
    page,
    browser,
  }) => {
    const saleId = await buyAsGuest(browser, `/l/${SEED.freeProductPermalink}`);
    await page.goto(`/customers/sale/${saleId}`);
    await expect(page.getByRole("heading", { name: SEED.freeProductName }).first()).toBeVisible();
    await expect(page.getByText("helped you make this sale")).toHaveCount(0);
  });
});
