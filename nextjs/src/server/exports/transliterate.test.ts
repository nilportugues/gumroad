import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/purchase-export-transliterate.golden.json" with { type: "json" };
import { pseudoTransliterate, transliterate } from "./transliterate.ts";

// scripts/golden/purchase-export-transliterate.rb holds what ActiveSupport::Inflector.transliterate answers in Ruby.
describe("transliterate", () => {
  it("matches Ruby for every code point it approximates", () => {
    expect(Object.keys(golden.table).length).toBeGreaterThan(250);
    for (const [char, expected] of Object.entries(golden.table)) expect(transliterate(char), char).toBe(expected);
  });

  it("matches Ruby for the sampled strings", () => {
    for (const [value, expected] of Object.entries(golden.samples)) expect(transliterate(value), value).toBe(expected);
  });

  it("answers the replacement for a character the table does not list", () => {
    expect(transliterate("\u{1F600}")).toBe("?");
    expect(transliterate(" ")).toBe("?");
  });
});

describe("pseudoTransliterate", () => {
  it("transliterates a string the table covers", () => {
    expect(pseudoTransliterate("Marktstraße")).toBe("Marktstrasse");
    expect(pseudoTransliterate("São Paulo")).toBe("Sao Paulo");
  });

  it("keeps the original of a string with an unlisted character or a question mark", () => {
    expect(pseudoTransliterate("東京")).toBe("東京");
    expect(pseudoTransliterate("Zürich?")).toBe("Zürich?");
  });

  it("passes a missing value and plain ASCII through", () => {
    expect(pseudoTransliterate(null)).toBeNull();
    expect(pseudoTransliterate("1 Market Street")).toBe("1 Market Street");
  });
});
