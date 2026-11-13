import { present } from "../support/assert";
import { SEED, stripeTestKeysConfigured, uniqueEmail } from "../support/env";
import { expect, test } from "../support/fixtures";

// blockExternalRequests lets stripe.com through only when Stripe *test* keys are configured.
// Live keys (pk_live_/sk_live_) never match stripeTestKeysConfigured().
test.describe("@stripe paid card checkout", () => {
  test.skip(
    !stripeTestKeysConfigured(),
    "Stripe test keys (STRIPE_PUBLISHABLE_KEY=pk_test_..., STRIPE_SECRET_KEY=sk_test_...) not configured",
  );

  test("buying a paid product with the 4242 test card", async ({ page }) => {
    await page.goto(`/l/${SEED.membershipPermalink}`);
    const href = await page
      .locator(`a[href*="/checkout?product=${SEED.membershipPermalink}"]`)
      .first()
      .getAttribute("href");
    await page.goto(present(href, "the checkout link href"));
    await page.getByLabel("Email address").fill(uniqueEmail("card"));
    const card = page.frameLocator("iframe[title*='card number' i]").first();
    await card.getByPlaceholder(/1234/u).fill("4242424242424242");
    await page.frameLocator("iframe[title*='expiration' i]").first().getByPlaceholder(/MM/u).fill("12 / 34");
    await page.frameLocator("iframe[title*='security code' i]").first().getByPlaceholder(/CVC/u).fill("123");
    await page.getByRole("button", { name: /^Pay/u }).click();
    await page.waitForURL(/\/d\/[a-f0-9]+/u, { timeout: 120_000 });
    await expect(page.getByText(/Beautiful membership/u).first()).toBeVisible();
  });
});
