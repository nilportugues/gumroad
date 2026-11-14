import { describe, expect, it } from "vitest";

import { nokogiriRoundtrip } from "./html-fragment.ts";

describe("nokogiriRoundtrip product list placeholder", () => {
  it("writes the self-closing marker as an open and close tag", () => {
    expect(nokogiriRoundtrip("<p>Back</p><product-list-placeholder />Thanks!")).toBe(
      "<p>Back</p><product-list-placeholder></product-list-placeholder>Thanks!",
    );
  });

  it("keeps the empty element that is already open and closed", () => {
    const html = "<p>Back</p><product-list-placeholder></product-list-placeholder>";
    expect(nokogiriRoundtrip(html)).toBe(html);
  });

  it("refuses a placeholder with content, attributes or a stray closing tag", () => {
    for (const html of [
      "<product-list-placeholder>x</product-list-placeholder>",
      '<product-list-placeholder id="a" />',
      "</product-list-placeholder>",
    ])
      expect(() => nokogiriRoundtrip(html)).toThrow();
  });

  it("still refuses other custom elements", () => {
    expect(() => nokogiriRoundtrip("<upsell-card></upsell-card>")).toThrow();
  });
});
