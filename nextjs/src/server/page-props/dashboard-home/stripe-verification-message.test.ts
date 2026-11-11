import type { User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aliveStripeAccountsOf = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
vi.mock("../../models/merchant-account.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/merchant-account.ts")>()),
  aliveStripeAccountsOf,
}));
vi.mock("../../../lib/db.ts", () => ({ db: { userComplianceInfoRequest: { findMany } } }));

import { HandBackToRails } from "../../controllers/application-controller.ts";

import { stripeVerificationMessage } from "./creator-home.ts";

const seller = { id: 7n } as User;
const ownAccount = { charge_processor_id: "stripe", json_data: null };
const request = (verificationError: unknown) => ({
  json_data: JSON.stringify({ verification_error: verificationError }),
});

beforeEach(() => {
  aliveStripeAccountsOf.mockReset().mockResolvedValue([ownAccount]);
  findMany.mockReset().mockResolvedValue([]);
});

describe("stripeVerificationMessage", () => {
  it("is empty without a Stripe account of the seller's own, without reading requests", async () => {
    aliveStripeAccountsOf.mockResolvedValue([]);
    expect(await stripeVerificationMessage(seller)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("names the message for a verification error code", async () => {
    findMany.mockResolvedValue([request({ code: "verification_document_name_missing" })]);
    expect(await stripeVerificationMessage(seller)).toBe(
      "The uploaded document is missing the name. Please upload another document that contains the name.",
    );
    expect(findMany).toHaveBeenCalledWith({ where: { user_id: 7, state: "requested" }, orderBy: { id: "asc" } });
  });

  it("prefers the message Stripe sent over the code's text", async () => {
    findMany.mockResolvedValue([
      request({ code: "verification_failed_other", message: "Stripe could not verify this number!" }),
    ]);
    expect(await stripeVerificationMessage(seller)).toBe("Stripe could not verify this number!");
  });

  it("lets the last request with a message win and skips requests without one", async () => {
    findMany.mockResolvedValue([
      request({ code: "verification_document_fraudulent" }),
      request({ code: "verification_failed_other" }),
      { json_data: null },
      request({ code: "unknown_code" }),
    ]);
    expect(await stripeVerificationMessage(seller)).toBe("There was a problem with your identity verification.");
  });

  it("is empty when no request carries a message", async () => {
    findMany.mockResolvedValue([{ json_data: JSON.stringify({}) }, request({})]);
    expect(await stripeVerificationMessage(seller)).toBeNull();
  });

  it("hands an address-mismatch code back for the P.O. Box check", async () => {
    findMany.mockResolvedValue([request({ code: "verification_document_address_mismatch" })]);
    await expect(stripeVerificationMessage(seller)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
