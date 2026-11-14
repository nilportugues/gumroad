import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { generateTransientCustomerToken } from "./checkout-processor-guards.ts";
import type { MutationInput } from "./mutation.ts";

const input = (params: Record<string, unknown>) => ({ params }) as unknown as MutationInput;

describe("BraintreeController#generate_transient_customer_token", () => {
  it("answers null for a blank nonce, which Rails does before it calls Braintree", async () => {
    for (const params of [{}, { braintree_nonce: null }, { braintree_nonce: "" }, { braintree_nonce: " \n" }])
      expect(await generateTransientCustomerToken(input(params))).toMatchObject({ status: 200 });
  });

  it("hands a nonce to Rails, which tokenizes it with Braintree", async () => {
    await expect(generateTransientCustomerToken(input({ braintree_nonce: "fake-nonce" }))).rejects.toThrow(
      HandBackToRails,
    );
  });

  it("hands a nonce that is not text to Rails", async () => {
    await expect(generateTransientCustomerToken(input({ braintree_nonce: ["x"] }))).rejects.toThrow(HandBackToRails);
  });
});
