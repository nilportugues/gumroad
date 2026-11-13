import { expect, test } from "../support/fixtures";

test.describe("discover", () => {
  test("the landing page lists featured products", async ({ page }) => {
    await page.goto("/discover");
    await expect(page.getByRole("heading", { name: "Featured products" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Beautiful .* widget/u }).first()).toBeVisible();
  });

  test("a category page lists its products", async ({ page }) => {
    await page.goto("/discover");
    await page.getByRole("menuitem", { name: "Design", exact: true }).click();
    await expect(page).toHaveURL(/\/design/u);
    await expect(page.getByRole("heading", { name: /design widget/iu }).first()).toBeVisible();
  });

  test("searching returns matching products", async ({ page }) => {
    await page.goto("/discover");
    const search = page.getByPlaceholder("Search products");
    await search.fill("widget");
    await search.press("Enter");
    await expect(page).toHaveURL(/query=widget/u);
    await expect(page.getByRole("heading", { name: /widget/iu }).first()).toBeVisible();
  });

  test("a search with no matches says so", async ({ page }) => {
    await page.goto("/discover?query=zzzz-no-such-product-zzzz");
    await expect(page.getByText(/no products found/iu)).toBeVisible();
  });
});
