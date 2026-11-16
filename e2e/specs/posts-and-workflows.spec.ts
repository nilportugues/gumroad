import { logInAsSeededSeller } from "../support/auth";
import { uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";
import { createPost, createWorkflow } from "../support/seller";

test.describe("seller emails and workflows", () => {
  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
  });

  test("a post is saved as a draft and listed", async ({ page }) => {
    const title = `E2E post ${uniqueSuffix()}`;
    await createPost(page, { title, body: "Hello from the e2e suite." });
    await expect(page).toHaveURL(/\/emails\/[^/]+\/edit/u);
    await page.goto("/emails/drafts");
    await expect(page.getByText(title).first()).toBeVisible();
  });

  test("a workflow is created and lands on its emails", async ({ page }) => {
    await createWorkflow(page, `E2E workflow ${uniqueSuffix()}`);
    await expect(page).toHaveURL(/\/workflows\/[^/]+\/emails/u);
  });
});
