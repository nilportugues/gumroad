import { expect, type Page } from "@playwright/test";

import { present } from "./assert";

/** Creates a digital product through the "new product" form and returns its permalink (read from the edit URL). */
export const createProduct = async (
  page: Page,
  { name, priceDollars, type }: { name: string; priceDollars: number; type?: "Membership" },
) => {
  await page.goto("/products/new");
  if (type) await page.getByRole("radio", { name: new RegExp(type, "u") }).click();
  const textInputs = page.locator("input[type=text]");
  await textInputs.first().fill(name);
  // The price field is the second text input on the form.
  await textInputs.nth(1).fill(String(priceDollars));
  await page.getByRole("button", { name: "Next: Customize" }).click();
  await page.waitForURL(/\/products\/[^/]+\/edit/u, { timeout: 90_000 });
  const permalink = present(new URL(page.url()).pathname.split("/")[2], "the product permalink in the edit URL");
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return permalink;
};

export const publishProduct = async (page: Page, permalink: string) => {
  await page.goto(`/products/${permalink}/edit/share`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible({ timeout: 60_000 });
};

/** The tab rows are plain links, so a heading check is enough to know a page rendered. */
export const expectHeading = (page: Page, name: string | RegExp) =>
  expect(page.getByRole("heading", { name }).first()).toBeVisible({ timeout: 60_000 });

export const createPost = async (page: Page, { title, body }: { title: string; body: string }) => {
  await page.goto("/emails/new");
  await page.getByPlaceholder("Title").fill(title);
  await page.locator("[aria-label='Email message']").click();
  await page.keyboard.type(body);
  await page.getByRole("button", { name: "Save", exact: true }).click();
};

export const createWorkflow = async (page: Page, name: string) => {
  await page.goto("/workflows/new");
  await page.locator("input[type=text]").first().fill(name);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(/\/workflows\/[^/]+\/emails/u, { timeout: 60_000 });
};

/** Creates a percentage discount code limited to one product (picked by its exact name) and waits for it to be listed. */
export const createDiscount = async (
  page: Page,
  { code, productName, percent }: { code: string; productName: string; percent: number },
) => {
  await page.goto("/checkout/discounts");
  await page.getByRole("button", { name: "New discount" }).first().click();
  await page.getByLabel("Name").fill(`E2E ${code}`);
  await page.getByLabel("Discount code").fill(code);
  await page.getByRole("combobox", { name: "Products" }).click();
  await page.getByRole("option", { name: productName, exact: true }).click();
  await page.getByRole("textbox", { name: "Percentage", exact: true }).fill(String(percent));
  await page.getByRole("button", { name: "Add discount" }).click();
  await expect(page.getByText(code).first()).toBeVisible();
};

/** Adds an existing account as an affiliate on all products and waits for the affiliates list. */
export const addAffiliate = async (
  page: Page,
  { email, commissionPercent }: { email: string; commissionPercent: number },
) => {
  await page.goto("/affiliates/new");
  await page.getByPlaceholder("Email of a Gumroad creator").fill(email);
  await page.getByRole("switch", { name: "Enable all products" }).click();
  await page.getByRole("textbox", { name: "Commission" }).first().fill(String(commissionPercent));
  await page.getByRole("button", { name: "Add affiliate" }).click();
  await expect(page).toHaveURL(/\/affiliates(\?|$)/u);
};
