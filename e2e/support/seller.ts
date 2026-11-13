import { expect, type Page } from "@playwright/test";

/** Creates a digital product through the "new product" form and returns its permalink (read from the edit URL). */
export const createProduct = async (page: Page, { name, priceDollars }: { name: string; priceDollars: number }) => {
  await page.goto("/products/new");
  const textInputs = page.locator("input[type=text]");
  await textInputs.first().fill(name);
  // The price field is the second text input on the form.
  await textInputs.nth(1).fill(String(priceDollars));
  await page.getByRole("button", { name: "Next: Customize" }).click();
  await page.waitForURL(/\/products\/[^/]+\/edit/, { timeout: 90_000 });
  const permalink = new URL(page.url()).pathname.split("/")[2]!;
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return permalink;
};

export const publishProduct = async (page: Page, permalink: string) => {
  await page.goto(`/products/${permalink}/edit`);
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
  await page.getByRole("button", { name: /^Purchase/ }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(/\/workflows\/[^/]+\/emails/, { timeout: 60_000 });
};
