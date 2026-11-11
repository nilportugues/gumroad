import { describe, expect, it } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";
import { checkoutProduct } from "./checkout-product.ts";

const membership = { id: 1n, user_id: 2n, flags: 2n } as never;

describe("checkoutProduct", () => {
  it("hands back a membership offered by a cross-sell, whose restart token is signed by Rails", async () => {
    await expect(checkoutProduct(membership, { arrival: true })).rejects.toBeInstanceOf(NotPortedError);
  });
});
