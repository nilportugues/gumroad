import { describe, expect, it } from "vitest";

import { RubyFloat } from "../models/concerns/ruby-values.ts";

import { HandBackToRails } from "./application-controller.ts";
import { compactNils, parseBody } from "./rails-body.ts";

const json = (text: string) => new TextEncoder().encode(text);

describe("compactNils", () => {
  it("removes nulls from lists, children first, and keeps an emptied list", () => {
    expect(compactNils({ a: [null, 1, [null], { b: [null, "x"] }], c: [null], d: null })).toEqual({
      a: [1, [], { b: ["x"] }],
      c: [],
      d: null,
    });
  });
});

describe("parseBody with a null inside a list", () => {
  it("hands the request back by default", () => {
    expect(() => parseBody("application/json", json('{"query":[null,"x"]}'))).toThrow(HandBackToRails);
  });

  it("drops the null when the caller asks for deep_munge", () => {
    expect(parseBody("application/json", json('{"query":[null,"x"]}'), false, true)).toEqual({ query: ["x"] });
  });
});

describe("compactNils with a float kept as a RubyFloat", () => {
  it("leaves the float alone", () => {
    const parsed = parseBody("application/json", json('{"query":[null,4.5]}'), true, true);
    expect(parsed.query).toHaveLength(1);
    expect((parsed.query as unknown[])[0]).toBeInstanceOf(RubyFloat);
  });
});
