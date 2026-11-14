import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/rails-cookies.golden.json" with { type: "json" };
import { authenticatableSalt, digestPassword, validPassword } from "./devise-password.ts";

// Hashes and verdicts come from Devise::Encryptor 4.9.4 on bcrypt-ruby 3.1.22.
describe("Devise password parity", () => {
  const cases = golden.bcrypt.flatMap((vector) =>
    Object.entries(vector.compare).map(([attempt, expected]) => [vector.password.slice(0, 16), attempt.slice(0, 16), vector, attempt, expected] as const),
  );

  it.each(cases)("hash of %j compared with %j matches Ruby", async (_p, _a, vector, attempt, expected) => {
    expect(await validPassword(vector.hash, attempt, { pepper: vector.pepper, stretches: vector.cost })).toBe(expected);
  });

  it("rejects the legacy sha256 hashes User#valid_password? rescues", async () => {
    expect(await validPassword("5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8", "password", { pepper: null, stretches: 4 })).toBe(false);
  });

  it("rejects blank hashes and nil passwords", async () => {
    expect(await validPassword("", "anything", { pepper: null, stretches: 4 })).toBe(false);
    const hash = await digestPassword("secret", { pepper: "p", stretches: 4 });
    expect(await validPassword(hash, null, { pepper: "p", stretches: 4 })).toBe(false);
  });

  it("writes hashes Devise can read, with the pepper", async () => {
    const hash = await digestPassword("secret", { pepper: "p", stretches: 4 });
    expect(hash).toMatch(/^\$2[ab]\$04\$/u);
    expect(await validPassword(hash, "secret", { pepper: "p", stretches: 4 })).toBe(true);
    expect(await validPassword(hash, "secret", { pepper: null, stretches: 4 })).toBe(false);
  });

  it("takes the authenticatable salt from the first 29 characters", () => {
    expect(authenticatableSalt(golden.bcrypt[0]!.hash)).toBe(golden.bcrypt[0]!.hash.slice(0, 29));
    expect(authenticatableSalt(null)).toBeNull();
  });
});
