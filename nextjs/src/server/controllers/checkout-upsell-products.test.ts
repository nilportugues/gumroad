import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { index } from "./checkout-upsell-products.ts";
import type { MutationInput } from "./mutation.ts";

const inputWith = (query: unknown) =>
  ({ params: { query }, request: { host: "app.example.com" } }) as unknown as MutationInput;

describe("Checkout::Upsells::ProductsController#index", () => {
  it.each([[["a"]], [{ name: "a" }]])("hands a query that is not text back to Rails: %j", async (query) => {
    await expect(index(inputWith(query))).rejects.toBeInstanceOf(HandBackToRails);
  });
});
