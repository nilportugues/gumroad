// Replays ruby-uri.golden.json (scripts/golden/ruby-uri.rb): URI.parse's scheme and host, or the
// error class and message it raises.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RubyUriError, rubyUriParse } from "./ruby-uri.ts";

type Vector = { input: string; scheme?: string | null; host?: string | null; error?: { class: string; message: string } };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/ruby-uri.golden.json", import.meta.url), "utf8")) as { vectors: Vector[] };

function outcome(input: string): Omit<Vector, "input"> {
  try {
    return rubyUriParse(input);
  } catch (error) {
    if (!(error instanceof RubyUriError)) throw error;
    return { error: { class: error.rubyClass, message: error.message } };
  }
}

describe("rubyUriParse", () => {
  it(`matches URI.parse on ${golden.vectors.length} inputs`, () => {
    const mismatches = golden.vectors.filter(({ input, ...expected }) => JSON.stringify(outcome(input)) !== JSON.stringify(expected));
    expect(mismatches.slice(0, 5).map((v) => ({ ...v, node: outcome(v.input) }))).toEqual([]);
  });
});
