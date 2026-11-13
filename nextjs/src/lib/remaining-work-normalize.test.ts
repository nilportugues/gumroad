import { describe, expect, it } from "vitest";

import { normalizeParams } from "../../scripts/remaining-work.ts";

describe("remaining-work normalizeParams", () => {
  it("gives a routes.json key and the Rails path it serves the same form", () => {
    const pairs = [
      ["/products/:id/builds.json", "/products/:product_id/builds"],
      ["/product_review_videos/:id/stream.smil", "/product_review_videos/:product_review_video_id/stream"],
      ["/global_affiliates/product_eligibility/*url", "/global_affiliates/product_eligibility/:url"],
      ["/users/:id(.:format)", "/users/:user_id"],
    ] as const;
    for (const [key, rails] of pairs) expect(normalizeParams(key)).toBe(normalizeParams(rails));
  });

  it("keeps routes that differ in a literal segment apart", () => {
    expect(normalizeParams("/products/:id/builds.json")).not.toBe(normalizeParams("/products/:id/edit"));
  });
});
