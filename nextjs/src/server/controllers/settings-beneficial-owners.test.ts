import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MutationInput, MutationSpec } from "./mutation.ts";

const { specs, jsonSellerGuard, stripeAccountOf, aliveUserComplianceInfoRow } = vi.hoisted(() => ({
  specs: [] as MutationSpec[],
  jsonSellerGuard: vi.fn(),
  stripeAccountOf: vi.fn(),
  aliveUserComplianceInfoRow: vi.fn(),
}));

vi.mock("./mutation.ts", () => ({
  registerMutations: (...registered: MutationSpec[]) => void specs.push(...registered),
}));
vi.mock("./seller-json-guard.ts", async (original) => ({
  ...(await original<typeof import("./seller-json-guard.ts")>()),
  jsonSellerGuard,
}));
vi.mock("../models/merchant-account.ts", () => ({ stripeAccountOf }));
vi.mock("../models/user-compliance-info.ts", () => ({ aliveUserComplianceInfoRow }));
vi.mock("../policies/settings/payments-user.ts", () => ({ settingsPaymentsUserPolicy: { update: () => true } }));

await import("./settings-beneficial-owners.ts");

const input = { context: { currentSeller: { id: 7n } } } as unknown as MutationInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body) as unknown;

beforeEach(() => {
  jsonSellerGuard.mockReset().mockResolvedValue(null);
  stripeAccountOf.mockReset().mockResolvedValue({ id: 1n });
  aliveUserComplianceInfoRow.mockReset().mockResolvedValue({ is_business: true });
});

describe("Settings::BeneficialOwnersController guards", () => {
  it("registers create, update and destroy", () => {
    expect(specs.map((spec) => spec.method).sort()).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "answers 403 on %s without a Gumroad-managed Stripe account",
    async (method) => {
      stripeAccountOf.mockResolvedValue(null);

      const result = await specs.find((spec) => spec.method === method)!.run(input);

      expect(result).toMatchObject({ status: 403, rescued: true });
      expect(body(result)).toEqual({
        error: "Beneficial owners can only be managed on business accounts using Gumroad-managed Stripe.",
      });
    },
  );

  it.each([
    ["no compliance revision", null],
    ["an individual", { is_business: false }],
  ])("answers 403 for %s", async (_label, row) => {
    aliveUserComplianceInfoRow.mockResolvedValue(row);

    expect(await specs[0]!.run(input)).toMatchObject({ status: 403 });
  });

  it("serves the refusal of the seller guard before checking eligibility", async () => {
    const refusal = { status: 401, body: "{}", contentType: "application/json", rescued: true };
    jsonSellerGuard.mockResolvedValue(refusal);

    expect(await specs[0]!.run(input)).toEqual({ ...refusal, paramsRead: true });
    expect(stripeAccountOf).not.toHaveBeenCalled();
  });

  it("hands an eligible seller's request to Rails, which calls Stripe", async () => {
    await expect(specs[0]!.run(input)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
