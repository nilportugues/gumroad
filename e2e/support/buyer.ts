import { expect, type Page } from "@playwright/test";

/** Opens a product by permalink. The app redirects to the seller's subdomain, which *.localhost resolves in Chromium. */
export const openProduct = async (page: Page, permalink: string) => {
  await page.goto(`/l/${permalink}`);
  await expect(page.locator("h1").first()).toBeVisible();
};

/**
 * The buy button is an anchor to /checkout?product=...; a sticky copy sits outside the viewport on some layouts,
 * so navigate to its href instead of clicking it.
 */
export const startCheckout = async (page: Page, permalink: string) => {
  const href = await page.locator(`a[href*="/checkout?product=${permalink}"]`).first().getAttribute("href");
  expect(href, `no checkout link for ${permalink}`).toBeTruthy();
  await page.goto(href!);
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
};

/** Completes a free checkout. The email field is only shown (and required) when not signed in. */
export const completeFreeCheckout = async (page: Page, { email }: { email?: string } = {}) => {
  // Waits for hydration: checking visibility first races it and submits an empty email.
  if (email) await page.getByLabel("Email address").fill(email);
  const submit = page.getByRole("button", { name: "Get", exact: true });
  await expect(submit).toBeEnabled();
  // Let the quote request that follows the email edit settle so the click is not swallowed by a re-render.
  await page.waitForLoadState("networkidle");
  await submit.click();
  await page.waitForURL(/\/d\/[a-f0-9]+/, { timeout: 90_000 });
};

export const buyFreeProduct = async (page: Page, permalink: string, opts: { email?: string } = {}) => {
  await openProduct(page, permalink);
  await startCheckout(page, permalink);
  await completeFreeCheckout(page, opts);
};
