import { describe, expect, it } from "vitest";

import { decrypt, encrypt, encryptNumeric } from "@/lib/obfuscate-ids";

import { goldenCases, goldenInput, isRaise, loadGolden } from "../src/golden";

// Both files are bin/golden output; see nextjs/parity/golden/*.json for the specs.
const keys = { cipherKey: "test-cipher-key", numericCipherKey: 123456789 };
const main = loadGolden(new URL("../../src/lib/__fixtures__/obfuscate-ids.golden.json", import.meta.url));
const edges = loadGolden(new URL("./obfuscate-ids-edges.golden.json", import.meta.url));

describe("golden fixture helpers", () => {
  it.each(goldenCases(main, "decrypt"))("reads string-keyed vectors (decrypt %j)", (input, expected) => {
    expect(decrypt(input, keys)).toBe(expected);
  });

  it.each(goldenCases(edges, "encrypt_beyond_safe_integers"))("revives $big inputs as bigint (%s)", (key, expected) => {
    const input = goldenInput(key);
    expect(typeof input).toBe("bigint");
    expect(encrypt(input as bigint, {}, keys)).toBe(expected);
  });

  it("records Ruby exceptions as vectors", () => {
    const [[key, expected]] = goldenCases(edges, "encrypt_numeric_out_of_range") as [[string, unknown]];
    expect(isRaise(expected as never)).toBe(true);
    expect(() => encryptNumeric(Number(goldenInput(key)), keys)).toThrow(RangeError);
  });
});
