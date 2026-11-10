// Strong-parameter handling of Settings::ThirdPartyAnalyticsController, AdvancedController and Team::MembersController updates.
import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { blockedEmailLines, isPermittedScalar, stringValue, tiktokPixelIdValue } from "./settings-mutations.ts";
import { permittedRole } from "./settings-team-mutations.ts";

describe("isPermittedScalar", () => {
  it("accepts strings, numbers, booleans and nil, and rejects arrays and hashes", () => {
    for (const value of ["a", 1, 1.5, true, false, null]) expect(isPermittedScalar(value)).toBe(true);
    for (const value of [[], ["a"], {}, { a: 1 }]) expect(isPermittedScalar(value)).toBe(false);
  });
});

describe("stringValue", () => {
  it("casts booleans to t/f and integers to their digits like a string column", () => {
    expect(stringValue(true)).toBe("t");
    expect(stringValue(false)).toBe("f");
    expect(stringValue(12345)).toBe("12345");
    expect(stringValue(-7)).toBe("-7");
    expect(stringValue(null)).toBeNull();
    expect(stringValue("UA-1")).toBe("UA-1");
  });

  it("hands back a float, which Rails would keep as a Float", () => {
    expect(() => stringValue(1.5)).toThrow(HandBackToRails);
  });
});

describe("tiktokPixelIdValue", () => {
  it("keeps a JSON integer as an integer, since json_data takes the value uncast", () => {
    expect(tiktokPixelIdValue(12345)).toBe(12345);
    expect(tiktokPixelIdValue(-7)).toBe(-7);
  });

  it("keeps a string or nil and hands back a float or a boolean", () => {
    expect(tiktokPixelIdValue("CFH83AJC77UUUGLE2TJG")).toBe("CFH83AJC77UUUGLE2TJG");
    expect(tiktokPixelIdValue(null)).toBeNull();
    expect(() => tiktokPixelIdValue(1.5)).toThrow(HandBackToRails);
    expect(() => tiktokPixelIdValue(true)).toThrow(HandBackToRails);
  });
});

describe("blockedEmailLines", () => {
  it("is empty for a missing, nil, false or blank value", () => {
    expect(blockedEmailLines(undefined)).toEqual([]);
    expect(blockedEmailLines(null)).toEqual([]);
    expect(blockedEmailLines(false)).toEqual([]);
    expect(blockedEmailLines("  \n ")).toEqual([]);
  });

  it("splits on runs of CR and LF, dropping trailing empties", () => {
    expect(blockedEmailLines("a@example.com\r\n\r\nb@example.com\n")).toEqual(["a@example.com", "b@example.com"]);
  });

  it("raises for a number or true, which have no split", () => {
    expect(() => blockedEmailLines(5)).toThrow(/split/u);
    expect(() => blockedEmailLines(0)).toThrow(/split/u);
    expect(() => blockedEmailLines(true)).toThrow(/split/u);
  });
});

describe("permittedRole", () => {
  it("returns a string role", () => {
    expect(permittedRole({ team_membership: { role: "admin" } })).toEqual({ role: "admin" });
  });

  it("returns nothing to change when the role is absent or an array or hash that permit drops", () => {
    expect(permittedRole({ team_membership: { other: 1 } })).toEqual({});
    expect(permittedRole({ team_membership: { role: ["admin"] } })).toEqual({});
    expect(permittedRole({ team_membership: { role: { a: "admin" } } })).toEqual({});
  });

  it("hands back a missing hash and a scalar role that is not a string", () => {
    expect(() => permittedRole({})).toThrow(HandBackToRails);
    expect(() => permittedRole({ team_membership: {} })).toThrow(HandBackToRails);
    expect(() => permittedRole({ team_membership: { role: 5 } })).toThrow(HandBackToRails);
    expect(() => permittedRole({ team_membership: { role: null } })).toThrow(HandBackToRails);
  });
});
