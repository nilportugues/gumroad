import { expect, type Page } from "@playwright/test";

import { present } from "./assert";

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
  await page.goto(present(href, "the checkout link href"));
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
};

/** Completes a free checkout. The email field is only shown (and required) when not signed in. */
export const completeFreeCheckout = async (
  page: Page,
  { email, landing = /\/d\/[a-f0-9]+/u }: { email?: string; landing?: RegExp } = {},
) => {
  // Waits for hydration: checking visibility first races it and submits an empty email.
  if (email) await page.getByLabel("Email address").fill(email);
  const submit = page.getByRole("button", { name: "Get", exact: true });
  await expect(submit).toBeEnabled();
  // Let the quote request that follows the email edit settle so the click is not swallowed by a re-render.
  // Bounded: a discounted checkout keeps a request in flight, so idle may never come.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await submit.click();
  await page.waitForURL(landing, { timeout: 90_000 });
};

export const buyFreeProduct = async (page: Page, permalink: string, opts: { email?: string } = {}) => {
  await openProduct(page, permalink);
  await startCheckout(page, permalink);
  await completeFreeCheckout(page, opts);
};

/** A signed-in account's saved cart can carry items from other runs; removes everything but `productName`. */
export const removeOtherCartItems = async (page: Page, productName: string) => {
  const others = page
    .getByRole("listitem")
    .filter({ hasNotText: productName })
    .filter({ has: page.getByRole("button", { name: "Remove" }) });
  while ((await others.count()) > 0) {
    const before = await others.count();
    await others.first().getByRole("button", { name: "Remove" }).click();
    await expect(others).toHaveCount(before - 1);
  }
};
