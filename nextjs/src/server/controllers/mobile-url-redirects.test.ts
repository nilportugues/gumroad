import { describe, expect, it } from "vitest";

import { FETCH_PLACEHOLDER_PRODUCTS } from "./mobile-url-redirects.ts";
import type { MobileInput } from "./mobile-api.ts";

describe("GET /mobile/url_redirects/fetch_placeholder_products", () => {
  it("is registered without an OAuth scope, as the Rails action only checks the mobile token", () => {
    expect(FETCH_PLACEHOLDER_PRODUCTS.method).toBe("GET");
    expect(FETCH_PLACEHOLDER_PRODUCTS.pattern).toBe("/mobile/url_redirects/fetch_placeholder_products");
    expect(FETCH_PLACEHOLDER_PRODUCTS.scopes).toBeNull();
  });

  it("answers 200 with an empty placeholder product list", async () => {
    const result = await FETCH_PLACEHOLDER_PRODUCTS.run({} as MobileInput, null);

    expect(result).toMatchObject({ status: 200, contentType: "application/json; charset=utf-8" });
    expect(JSON.parse((result as { body: string }).body)).toEqual({ success: true, placeholder_products: [] });
  });
});
