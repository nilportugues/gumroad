import { expect, test } from "../support/fixtures";

test.describe("discover", () => {
  test("the landing page lists featured products", async ({ page }) => {
    await page.goto("/discover");
    await expect(page.getByRole("heading", { name: "Featured products" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Beautiful .* widget/ }).first()).toBeVisible();
  });

  test("sorting tabs are reachable", async ({ page }) => {
    await page.goto("/discover");
    await page.getByRole("link", { name: "Best Sellers" }).click();
    await expect(page).toHaveURL(/sort=/);
  });

  test("searching returns matching products", async ({ page }) => {
    await page.goto("/discover");
    const search = page.getByPlaceholder("Search products");
    await search.fill("widget");
    await search.press("Enter");
    await expect(page).toHaveURL(/query=widget/);
    await expect(page.getByRole("heading", { name: /widget/i }).first()).toBeVisible();
  });

  test("a search with no matches says so", async ({ page }) => {
    await page.goto("/discover?query=zzzz-no-such-product-zzzz");
    await expect(page.getByText(/no products found/i)).toBeVisible();
  });
});
