import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { emailIsInvalid } from "./orders-validations.ts";

// EmailFormatValidator.valid? recorded by __fixtures__/generate-order-email-validity-golden.rb.
const GOLDEN = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/order-email-validity.golden.json"), "utf8"),
) as Record<string, boolean>;
const JUDGEABLE = /^[!-~]*$/u;

describe("OrdersController#create email check", () => {
  it.each(Object.entries(GOLDEN).filter(([email]) => JUDGEABLE.test(email)))(
    "judges %j like EmailFormatValidator (valid: %s)",
    (email, valid) => {
      expect(emailIsInvalid(email)).toBe(!valid);
    },
  );

  it.each(Object.keys(GOLDEN).filter((email) => !JUDGEABLE.test(email)))(
    "hands %j back: spaces and non-ASCII characters are not judged",
    (email) => {
      expect(() => emailIsInvalid(email)).toThrow(HandBackToRails);
    },
  );

  it.each([undefined, null, ""])("refuses a missing email (%j)", (email) => {
    expect(emailIsInvalid(email)).toBe(true);
  });

  it("hands an email that is not text back", () => {
    expect(() => emailIsInvalid(["a@b.co"])).toThrow(HandBackToRails);
  });
});
