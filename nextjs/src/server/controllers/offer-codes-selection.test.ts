import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import { selectionDiscounts } from "./offer-codes-selection.ts";

const withAccept = (accept: string) =>
  ({
    params: { permalink: "abc" },
    request: { headers: new Headers({ accept, "x-requested-with": "XMLHttpRequest" }) },
  }) as unknown as MutationInput;

describe("OfferCodesController#selection_discounts", () => {
  it("hands a request whose format is neither HTML nor JSON back to Rails", async () => {
    await expect(selectionDiscounts(withAccept("text/csv"))).rejects.toBeInstanceOf(HandBackToRails);
  });
});
