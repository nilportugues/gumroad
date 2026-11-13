import { readFile } from "node:fs/promises";

import { present } from "../support/assert";
import { logInAsSeededSeller } from "../support/auth";
import { buyFreeProduct } from "../support/buyer";
import { uniqueEmail, uniqueSuffix } from "../support/env";
import { expect, test } from "../support/fixtures";
import { createProduct, publishProduct } from "../support/seller";

test.describe("buyer downloads a file", () => {
  test("the content page serves the exact file the seller uploaded", async ({ page, browser }) => {
    await logInAsSeededSeller(page);
    const permalink = await createProduct(page, { name: `E2E download ${uniqueSuffix()}`, priceDollars: 0 });
    const fileBase = `e2e-${uniqueSuffix()}`;
    const fileName = `${fileBase}.txt`;
    const fileText = `e2e file body ${uniqueSuffix()}`;

    await page.goto(`/products/${permalink}/edit/content`);
    await page.getByRole("button", { name: "Upload files" }).click();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Computer files" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from(fileText) });
    await expect(page.locator("[contenteditable] .embed").first()).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("toast-alert").getByText("Changes saved!")).toBeVisible();
    await publishProduct(page, permalink);

    const buyerContext = await browser.newContext();
    const buyer = await buyerContext.newPage();
    await buyFreeProduct(buyer, permalink, { email: uniqueEmail("download") });
    await expect(buyer.getByText(fileBase).first()).toBeVisible();
    const downloadPromise = buyer.waitForEvent("download");
    await buyer.getByRole("link", { name: "Download" }).first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    expect(await readFile(present(await download.path(), "the downloaded file path"), "utf8")).toBe(fileText);
    await buyerContext.close();
  });
});
