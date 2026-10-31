import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/obfuscate-ids.golden.json" with { type: "json" };
import { decrypt, decryptNumeric, encrypt, encryptNumeric } from "./obfuscate-ids";

// Vectors were produced by running app/modules/obfuscate_ids.rb itself with these keys.
const keys = { cipherKey: "test-cipher-key", numericCipherKey: 123456789 };

describe("ObfuscateIds parity with Ruby", () => {
  it.each(Object.entries(golden.encrypt))("encrypts %s with padding", (id, expected) => {
    expect(encrypt(BigInt(id), {}, keys)).toBe(expected);
  });

  it.each(Object.entries(golden.encrypt_unpadded))("encrypts %s without padding", (id, expected) => {
    expect(encrypt(BigInt(id), { padding: false }, keys)).toBe(expected);
  });

  it.each(Object.entries(golden.decrypt))("decrypts %j to %j, returning null where Ruby rescues", (input, expected) => {
    expect(decrypt(input, keys)).toBe(expected);
  });

  it.each(Object.entries(golden.encrypt_numeric))("numerically encrypts %s", (id, expected) => {
    expect(encryptNumeric(Number(id), keys)).toBe(expected);
  });

  it.each(Object.entries(golden.decrypt_numeric))("numerically decrypts %s", (id, expected) => {
    expect(decryptNumeric(Number(id), keys)).toBe(expected);
  });

  it("rejects numeric ids wider than 30 bits", () => {
    expect(() => encryptNumeric(2 ** 30, keys)).toThrow(RangeError);
  });
});
