import { describe, expect, it } from "vitest";

import { dumpJsonData } from "./json-data.ts";
import { RubyHash } from "./psych.ts";

describe("dumpJsonData", () => {
  it("escapes the characters ActiveSupport's encoder escapes, inside strings only", () => {
    const hash = new RubyHash([["a<b", "</b> & > \u2028 \u2029 é"]]);
    expect(dumpJsonData(hash)).toBe('{"a\\u003cb":"\\u003c/b\\u003e \\u0026 \\u003e \\u2028 \\u2029 é"}');
  });

  it("leaves other text as JSON.generate writes it", () => {
    expect(dumpJsonData(new RubyHash([["k", 'q"\\\u0000🎨']]))).toBe('{"k":"q\\"\\\\\\u0000🎨"}');
  });
});
