import { readFile } from "node:fs/promises";

import { present } from "../support/assert";
import { logInAsSeededSeller } from "../support/auth";
import { expect, test } from "../support/fixtures";

// New sales reach this page through the Elasticsearch index, which needs Sidekiq (plan task 5.1), so these specs
// do not assert on a sale made during the run.
test.describe("customers page", () => {
  test.beforeEach(async ({ page }) => {
    await logInAsSeededSeller(page);
    await page.goto("/customers");
    await expect(page.getByRole("button", { name: "Export" })).toBeVisible();
  });

  test("the sales page renders its heading and filter controls", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Sales" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter" })).toBeVisible();
  });

  test("the export popover downloads a CSV with the sales columns", async ({ page }) => {
    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.getByText("Download sales as CSV")).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^Sales.*\.csv$/u);
    const csv = await readFile(present(await download.path(), "the downloaded file path"), "utf8");
    const header = present(csv.split("\n")[0], "the CSV header row");
    expect(header).toContain("Purchase ID,Item Name");
    expect(header).toContain("Buyer Email");
  });
});
