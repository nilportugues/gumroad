import { describe, expect, it } from "vitest";

import { NotPortedError } from "../not-ported.ts";

import { verificationErrorMessage } from "./verification-error-message.ts";

describe("verificationErrorMessage", () => {
  it("is nil for a blank error", () => {
    expect(verificationErrorMessage(null)).toBeNull();
    expect(verificationErrorMessage({})).toBeNull();
  });

  it("uses the message Stripe sent over the code", () => {
    expect(verificationErrorMessage({ code: "verification_document_fraudulent", message: "Custom copy" })).toBe(
      "Custom copy",
    );
  });

  it("maps a known code to its copy", () => {
    expect(verificationErrorMessage({ code: "verification_document_fraudulent" })).toBe(
      "The document might have been altered so it could not be verified.",
    );
    expect(verificationErrorMessage({ code: "verification_missing_owners" })).toBe(
      "We have identified owners that haven’t been added on the account. Add any missing owners to the account.",
    );
  });

  it("is nil for an unknown code", () => {
    expect(verificationErrorMessage({ code: "something_new" })).toBeNull();
  });

  it("hands back address-mismatch codes, whose copy depends on the P.O. Box history", () => {
    expect(() => verificationErrorMessage({ code: "verification_failed_address_match" })).toThrow(NotPortedError);
    expect(() => verificationErrorMessage({ code: "verification_document_address_mismatch", message: "x" })).toThrow(
      NotPortedError,
    );
  });
});
