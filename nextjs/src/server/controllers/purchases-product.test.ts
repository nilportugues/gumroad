import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import { show } from "./purchases-product.ts";

describe("Purchases::ProductController#show", () => {
  it("hands a request that does not ask for HTML back to Rails before looking the purchase up", async () => {
    const input = {
      routeParams: { purchase_id: "x" },
      request: { headers: new Headers({ accept: "application/json" }) },
    };
    await expect(show(input as unknown as MutationInput)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
