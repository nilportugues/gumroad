import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deviseTokenDigest } from "../../auth/devise-token.ts";
import { redactEmail } from "./subscriptions.ts";

// Recorded from the real gems: EmailRedactorService.redact and Devise.token_generator.digest.
describe("redactEmail", () => {
  it.each([
    ["member@example.com", "m****r@e******.com"],
    ["a@b.co", "a@b.co"],
    ["ab@sub.example.co.uk", "ab@s*************.uk"],
    ["éa@ü.com", "éa@ü.com"],
    ["x@y.z", "x@y.z"],
  ])("redacts %s", (email, redacted) => {
    expect(redactEmail(email)).toBe(redacted);
  });

  it("raises for an address Ruby cannot split, as the presenter does", () => {
    expect(() => redactEmail("")).toThrow();
    expect(() => redactEmail("no-at-sign")).toThrow();
    expect(() => redactEmail("user@localhost")).toThrow();
  });
});

describe("deviseTokenDigest", () => {
  const saved = process.env.DEVISE_SECRET_KEY;
  beforeEach(() => {
    // The test environment's key (.env.test).
    process.env.DEVISE_SECRET_KEY =
      "8cb9397c5059e5d72aac2194f985dfd026423eed76a59692718b1d7bdcc0ea6eb9248a0a7ba91389a470782a4c91e8a9773cfe00737e8edd37bd0a5201bceca1";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DEVISE_SECRET_KEY;
    else process.env.DEVISE_SECRET_KEY = saved;
  });

  it("matches Devise.token_generator.digest(User, :reset_password_token, ...)", () => {
    expect(deviseTokenDigest("reset_password_token", "abc")).toBe("efa49c74c35c72307e2951650dbe478ea2b94b19e1eed86cf99713fe16452f51");
  });
});
