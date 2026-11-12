// Replays __fixtures__/rich-content-description.golden.json, which scripts/golden/rich-content-description.rb recorded from the real RichContent.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "test-cipher-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "1";

const {
  blockedHrefSchemes,
  browserCanonicalizedScheme,
  embeddedProductFileIds,
  hasLicenseKeyIn,
  isPlainDescription,
  rejectFileEmbeds,
  sameDescription,
} = await import("./rich-content-description.ts");

type Case = {
  name: string;
  description: never[];
  embeddedIds: number[];
  hasLicenseKey: boolean;
  blockedSchemes: string[];
  rejected: { ids: number[]; result: unknown }[];
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/rich-content-description.golden.json", import.meta.url), "utf8"),
) as { cases: Case[]; schemes: { href: string; scheme: string | null }[] };

describe("RichContent description readers (Ruby golden)", () => {
  it("has cases to replay", () => expect(golden.cases.length).toBeGreaterThan(50));

  for (const c of golden.cases) {
    it(`reads ${c.name} as Rails does`, () => {
      expect(isPlainDescription(c.description)).toBe(true);
      expect(embeddedProductFileIds(c.description)).toEqual(c.embeddedIds);
      expect(hasLicenseKeyIn(c.description)).toBe(c.hasLicenseKey);
      expect(blockedHrefSchemes(c.description)).toEqual(c.blockedSchemes);
      for (const { ids, result } of c.rejected) expect(rejectFileEmbeds(c.description, ids)).toEqual(result);
    });
  }

  for (const { href, scheme } of golden.schemes) {
    it(`canonicalizes the scheme of ${JSON.stringify(href)} to ${String(scheme)}`, () => {
      expect(browserCanonicalizedScheme(href)).toBe(scheme);
    });
  }
});

describe("sameDescription", () => {
  it("ignores key order and nothing else", () => {
    expect(sameDescription([{ a: 1, b: [1, 2] }], [{ b: [1, 2], a: 1 }])).toBe(true);
    expect(sameDescription([{ a: 1 }], [{ a: 1 }, { a: 1 }])).toBe(false);
    expect(sameDescription([{ a: 1 }], [{ a: 2 }])).toBe(false);
  });
});

describe("isPlainDescription", () => {
  it("refuses what Ruby would duck-type", () => {
    expect(isPlainDescription("[]")).toBe(false);
    expect(isPlainDescription([1])).toBe(false);
    expect(isPlainDescription([{ type: "fileEmbed", attrs: { id: 5 } }])).toBe(false);
    expect(isPlainDescription([{ type: "paragraph", content: "x" }])).toBe(false);
    expect(isPlainDescription([{ type: "paragraph", marks: [{ attrs: {} }] }])).toBe(false);
  });
});
