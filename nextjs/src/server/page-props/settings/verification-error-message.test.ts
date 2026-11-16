import { beforeEach, describe, expect, it, vi } from "vitest";

import { poBoxInAddressHistory } from "../../models/user-compliance-info.ts";

import { verificationErrorMessage } from "./verification-error-message.ts";

vi.mock("../../models/user-compliance-info.ts", () => ({ poBoxInAddressHistory: vi.fn() }));

const SELLER_ID = 42n;
const DEADLOCK = "Your registered address appears to be a P.O. Box";

describe("verificationErrorMessage", () => {
  beforeEach(() => {
    vi.mocked(poBoxInAddressHistory).mockReset().mockResolvedValue(false);
  });

  it("is nil for a blank error", async () => {
    expect(await verificationErrorMessage(null, SELLER_ID)).toBeNull();
    expect(await verificationErrorMessage({}, SELLER_ID)).toBeNull();
  });

  it("uses the message Stripe sent over the code", async () => {
    expect(
      await verificationErrorMessage({ code: "verification_document_fraudulent", message: "Custom copy" }, SELLER_ID),
    ).toBe("Custom copy");
  });

  it("maps a known code to its copy", async () => {
    expect(await verificationErrorMessage({ code: "verification_document_fraudulent" }, SELLER_ID)).toBe(
      "The document might have been altered so it could not be verified.",
    );
    expect(await verificationErrorMessage({ code: "verification_missing_owners" }, SELLER_ID)).toBe(
      "We have identified owners that haven’t been added on the account. Add any missing owners to the account.",
    );
  });

  it("is nil for an unknown code", async () => {
    expect(await verificationErrorMessage({ code: "something_new" }, SELLER_ID)).toBeNull();
  });

  it("does not read the address history for a code that is not an address mismatch", async () => {
    await verificationErrorMessage({ code: "verification_document_fraudulent" }, SELLER_ID);
    expect(poBoxInAddressHistory).not.toHaveBeenCalled();
  });

  it("replaces an address-mismatch code with the P.O. Box copy when the history holds a P.O. Box", async () => {
    vi.mocked(poBoxInAddressHistory).mockResolvedValue(true);
    expect(await verificationErrorMessage({ code: "verification_failed_address_match" }, SELLER_ID)).toContain(
      DEADLOCK,
    );
    expect(poBoxInAddressHistory).toHaveBeenCalledWith(SELLER_ID);
  });

  it("puts the P.O. Box copy before a message Stripe sent", async () => {
    vi.mocked(poBoxInAddressHistory).mockResolvedValue(true);
    expect(
      await verificationErrorMessage({ code: "verification_document_address_mismatch", message: "x" }, SELLER_ID),
    ).toContain(DEADLOCK);
  });

  it("keeps the ordinary address-mismatch copy when the history has no P.O. Box", async () => {
    expect(await verificationErrorMessage({ code: "verification_document_address_mismatch" }, SELLER_ID)).toBe(
      "The address on the ID document doesn’t match the address provided on the account. Please verify and correct the provided address on the account, or upload a document with address that matches the account.",
    );
    expect(
      await verificationErrorMessage({ code: "verification_failed_address_match", message: "Stripe says" }, SELLER_ID),
    ).toBe("Stripe says");
  });
});
