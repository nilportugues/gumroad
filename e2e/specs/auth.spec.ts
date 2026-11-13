import { logIn, logInAsSeededSeller, logOut, signUp } from "../support/auth";
import { NEW_PASSWORD, uniqueEmail } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("authentication", () => {
  test("a new seller signs up, logs out and logs back in", async ({ page }) => {
    const email = uniqueEmail("seller");
    await signUp(page, email);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" }).first()).toBeVisible();

    await logOut(page);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);

    await logIn(page, email, NEW_PASSWORD);
    await page.goto("/settings");
    await expect(page.locator("input[type=email]").first()).toHaveValue(email);
  });

  test("a wrong password is rejected", async ({ page }) => {
    await page.goto("/login");
    await page.locator("input[type=email]").fill(uniqueEmail("nobody"));
    await page.locator("input[type=password]").fill("not-the-password");
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/incorrect|invalid|couldn't find|wrong/i).first()).toBeVisible();
  });

  test("the seeded seller logs in through two-factor", async ({ page }) => {
    await logInAsSeededSeller(page);
    await page.goto("/products");
    await expect(page.getByRole("heading", { name: "Products" }).first()).toBeVisible();
  });
});
