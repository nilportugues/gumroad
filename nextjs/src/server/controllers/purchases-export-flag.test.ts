import { describe, expect, it, vi } from "vitest";

vi.mock("./mutation.ts", () => ({ registerMutations: vi.fn() }));

import { presentFlag } from "./purchases-export.ts";

describe("presentFlag", () => {
  it("reads nothing and ASCII whitespace as blank, as Ruby's blank? does", () => {
    for (const value of [undefined, null, "", " ", "\t\n \r"]) expect(presentFlag(value)).toBe(false);
  });

  it("reads a plain word as present", () => {
    expect(presentFlag("1")).toBe(true);
  });

  it("hands back Unicode spaces and structures", () => {
    expect(() => presentFlag(" ")).toThrow();
    expect(() => presentFlag(["1"])).toThrow();
  });
});
