import { logInAsSeededSeller } from "../support/auth";
import { uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";

const GUMBO_CREATORS = ["film", "music", "writing", "education", "software", "comics", "drawing", "animation", "audio", "games", "photography", "crafts", "design", "sports", "merchandise"];

test.describe("discount codes and affiliates", () => {
  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
  });

  test("a discount code is created and listed", async ({ page }) => {
    const code = `E2E${uniqueSuffix()}`.toUpperCase();
    await page.goto("/checkout/discounts");
    await page.getByRole("button", { name: "New discount" }).first().click();
    await page.getByLabel("Name").fill(`E2E ${code}`);
    await page.getByLabel("Discount code").fill(code);
    await page.getByLabel("Products").click();
    await page.getByRole("option", { name: "Beautiful widget", exact: true }).click();
    await page.getByRole("textbox", { name: "Percentage", exact: true }).fill("10");
    await page.getByRole("button", { name: "Add discount" }).click();
    await expect(page.getByText(code).first()).toBeVisible();
  });

  test("an affiliate is added by email", async ({ page }) => {
    await page.goto("/affiliates/new");
    // One affiliate per creator per seller: rotate so repeated runs against one database keep passing.
    const creator = GUMBO_CREATORS[Math.floor(Date.now() / 1000) % GUMBO_CREATORS.length]!;
    await page.getByPlaceholder("Email of a Gumroad creator").fill(`gumbo_${creator}@gumroad.com`);
    await page.getByRole("switch", { name: "Enable all products" }).click();
    await page.getByRole("textbox", { name: "Commission" }).first().fill("20");
    await page.getByRole("button", { name: "Add affiliate" }).click();
    await expect(page).toHaveURL(/\/affiliates(\?|$)/);
    await expect(page.getByRole("table").getByText(new RegExp(`Gumbo ${creator}`, "i")).first()).toBeVisible();
  });
});
