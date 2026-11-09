import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { htmlUndoReceipt } from "./store-agent-html-undo.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("htmlUndoReceipt", () => {
  const refused: [string, string, string][] = [
    ["<p>Original</p>", "", ""],
    ["<p>Original</p>", "<p>Original</p>", "<p>Original</p>"],
    ["<p>Original</p>", "<script>unsafe()</script>", ""],
    ["<p>Original</p><b>New</b>", "<b>New</b>", "<b>New</b><b>New</b>"],
    ["<p>Original</p>", "<b>New</b>", "<b>New</b><footer>Unexpected</footer>"],
  ];

  it.each(refused.map(([before, replace, after], index) => [index, before, replace, after]))(
    "refuses a saved transformation that is not reversible (case %i)",
    (_index, before, replace, after) => {
      expect(
        htmlUndoReceipt({
          endpoint: "edit_user_custom_html",
          pathParams: {},
          body: { find: "<p>Original</p>", replace },
          response: { success: true, previous_custom_html: before, custom_html: after },
        }),
      ).toBeNull();
    },
  );

  it("refuses an inverse whose overlapping replacement selects a different occurrence", () => {
    expect(
      htmlUndoReceipt({
        endpoint: "edit_user_custom_html",
        pathParams: {},
        body: { find: "<b>aa</b>", replace: "aa" },
        response: { success: true, previous_custom_html: "<p>a<b>aa</b></p>", custom_html: "<p>aaa</p>" },
      }),
    ).toBeNull();
  });

  it("refuses an unsuccessful response and an unknown endpoint", () => {
    const response = { success: false, previous_custom_html: "<p>a</p>", custom_html: "<p>b</p>" };
    expect(
      htmlUndoReceipt({
        endpoint: "edit_user_custom_html",
        pathParams: {},
        body: { find: "a", replace: "b" },
        response,
      }),
    ).toBeNull();
    expect(
      htmlUndoReceipt({
        endpoint: "delete_product",
        pathParams: {},
        body: { find: "a", replace: "b" },
        response: { success: true, previous_custom_html: "<p>a</p>", custom_html: "<p>b</p>" },
      }),
    ).toBeNull();
  });

  it("records the actual original snippet and both page digests after a reversible formatting edit", () => {
    const before = "<p>Keep this instruction.</p><footer>Unchanged</footer>";
    const after = "<p><strong>Keep this instruction.</strong></p><footer>Unchanged</footer>";

    const receipt = htmlUndoReceipt({
      endpoint: "edit_product_custom_html",
      pathParams: { id: "synthetic-product" },
      body: { find: "<p>Keep this instruction.</p>", replace: "<p><strong>Keep this instruction.</strong></p>" },
      response: { success: true, previous_custom_html: before, custom_html: after },
    });

    expect(receipt).toEqual({
      endpoint: "edit_product_custom_html",
      path_params: { id: "synthetic-product" },
      params: {
        find: "<p><strong>Keep this instruction.</strong></p>",
        replace: "<p>Keep this instruction.</p>",
        expected_custom_html_sha256: sha256(after),
        result_custom_html_sha256: sha256(before),
      },
    });
  });
});
