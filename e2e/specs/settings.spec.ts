import { signUp } from "../support/auth";
import { uniqueEmail } from "../support/env";
import { expect, test } from "../support/fixtures";

const SETTINGS_PAGES = [
  { path: "/settings", heading: "Settings" },
  { path: "/settings/payments", heading: "Payments" },
  { path: "/settings/password", heading: "Settings" },
  { path: "/settings/profile", heading: /Profile|Settings/ },
  { path: "/settings/advanced", heading: "Settings" },
  { path: "/settings/third_party_analytics", heading: "Settings" },
  { path: "/settings/team", heading: "Settings" },
];

test.describe("seller settings pages", () => {
  test.beforeEach(async ({ page }) => {
    await signUp(page, uniqueEmail("settings"));
  });

  for (const { path, heading } of SETTINGS_PAGES) {
    test(`${path} renders`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBeLessThan(400);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    });
  }

  test("changing a setting persists", async ({ page }) => {
    await page.goto("/settings");
    const name = page.locator("input[type=text]").first();
    await name.fill("E2E Seller");
    await page.getByRole("button", { name: "Update settings" }).click();
    await expect(page.getByText(/updated/i).first()).toBeVisible();
    await page.reload();
    await expect(page.locator("input[type=text]").first()).toHaveValue("E2E Seller");
  });
});
