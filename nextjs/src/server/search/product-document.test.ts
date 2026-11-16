// Replays the document cases of product-search.golden.json: Link#as_indexed_json and
// #build_search_update from the real app, statement for statement and request for request.
import { describe, expect, it } from "vitest";

import { PRODUCT_ATTRIBUTE_TO_SEARCH_FIELDS, PRODUCT_SEARCH_FIELDS, ProductRecord } from "./documents/product.ts";
import type { JsonValue } from "./es-json.ts";
import { productGolden, replayProductCase } from "./__fixtures__/product-search-golden.ts";

describe("Product::Searchable", () => {
  it("indexes the fields Ruby lists, in its order", () => {
    expect([...PRODUCT_SEARCH_FIELDS]).toEqual(productGolden.search_fields);
    expect(PRODUCT_ATTRIBUTE_TO_SEARCH_FIELDS).toEqual(productGolden.attribute_to_search_fields);
  });

  for (const c of productGolden.documents) {
    it(c.name, async () => {
      await replayProductCase(c, null, async (deps) => {
        const product = await ProductRecord.find(c.args[0], deps);
        return c.args.length > 1 ? product!.buildSearchUpdate(c.args[1] as JsonValue[]) : product!.asIndexedJson();
      });
    });
  }
});
