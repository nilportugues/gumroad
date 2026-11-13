import { describe, expect, it, vi } from "vitest";

vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));

import { centsValue, plainJson } from "./internal-api.ts";

describe("plainJson", () => {
  it("keeps a fraction both Ruby and Node print as a plain decimal", () => {
    expect(plainJson('{"progress":0.5,"low":-0.0001,"high":123456.789}')).toEqual({
      progress: 0.5,
      low: -0.0001,
      high: 123456.789,
    });
  });

  it.each(["1.0", "1e2", "0.00001", "1e15", "1.5e300", "-0.0"])("hands back %s, which Ruby would print differently", (n) => {
    expect(() => plainJson(`{"n":${n}}`)).toThrow(/plain fraction/u);
  });

  it("hands back an integer beyond 2^53", () => {
    expect(() => plainJson('{"n":9007199254740993}')).toThrow(/2\^53/u);
  });
});

describe("centsValue", () => {
  it("reads digits and digits with a decimal exponent as MySQL compares them", () => {
    expect(centsValue("paid_more_than_cents", "250")).toBe(250);
    expect(centsValue("paid_more_than_cents", "3e2")).toBe(300);
    expect(centsValue("paid_more_than_cents", "  ")).toBeNull();
  });

  it.each(["3.5", "-3", "0x10", "3e", "3e-2", "1e20", "1e100"])("hands back %s", (value) => {
    expect(() => centsValue("paid_more_than_cents", value)).toThrow(/plain digits/u);
  });
});
