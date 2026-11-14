import { describe, expect, it } from "vitest";

import { rubyInteger, workflowScheduleDispatchable } from "./product-affiliate.ts";

// `Integer(string, exception: false)` as Ruby 3.4 answers it.
const RUBY_INTEGERS: [string, number | null][] = [
  ["1762000245", 1762000245],
  ["0", 0],
  ["00", 0],
  ["010", 8],
  ["0x1A", 26],
  ["0b101", 5],
  ["0o17", 15],
  ["09", null],
  ["1_000", 1000],
  ["1__0", null],
  ["_1", null],
  ["1_", null],
  [" 12 ", 12],
  ["+5", 5],
  ["-7", -7],
  ["12abc", null],
  ["", null],
  ["59cb4f53-f22b", null],
  ["1e3", null],
  ["12.5", null],
  ["0x", null],
  ["0b2", null],
  ["٣", null],
];

describe("rubyInteger", () => {
  it.each(RUBY_INTEGERS)("%j", (text, expected) => {
    expect(rubyInteger(text)).toBe(expected);
  });
});

describe("workflowScheduleDispatchable", () => {
  const now = new Date("2025-11-01T12:30:45.123Z");
  const seconds = Math.floor(now.getTime() / 1000);

  it("takes over a claim once the lease has run out, inclusive", () => {
    expect(workflowScheduleDispatchable(`${seconds - 900}:abc`, now)).toBe(true);
    expect(workflowScheduleDispatchable(`${seconds - 899}:abc`, now)).toBe(false);
  });

  it("dispatches a token that was never claimed", () => {
    expect(workflowScheduleDispatchable("0b1f6e3c-6f1e-4c74-9d3f-3a0a63ea1f43", now)).toBe(true);
  });
});
