import { expect, type Page } from "@playwright/test";

import { NEW_PASSWORD, SEED } from "./env";

export const signUp = async (page: Page, email: string, password = NEW_PASSWORD) => {
  await page.goto("/signup");
  await page.locator("input[type=email]").fill(email);
  await page.locator("input[type=password]").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/signup/, { timeout: 90_000 });
};

/** Logs in, completing the development two-factor step (token prefilled and accepted outside production). */
export const logIn = async (page: Page, email: string, password: string) => {
  await page.goto("/login");
  await page.locator("input[type=email]").fill(email);
  await page.locator("input[type=password]").fill(password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.waitForURL(/\/(two-factor|dashboard|products|library)/, { timeout: 90_000 });
  if (page.url().includes("/two-factor")) {
    await page.locator("input[type=text]").fill(SEED.twoFactorToken);
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/two-factor"), { timeout: 90_000 });
  }
};

export const logInAsSeededSeller = (page: Page) => logIn(page, SEED.sellerEmail, SEED.sellerPassword);

export const logOut = async (page: Page) => {
  await page.goto("/logout");
  await page.waitForLoadState("load");
};
