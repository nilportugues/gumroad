// Strong-parameter handling of Settings::ThirdPartyAnalyticsController, AdvancedController and Team::MembersController updates.
import { describe, expect, it } from "vitest";

import { RubyFloat } from "../models/concerns/ruby-values.ts";

import { HandBackToRails, ParameterMissing } from "./application-controller.ts";
import { parseBody } from "./rails-body.ts";
import {
  blockedEmailLines,
  trueValue,
  isPermittedScalar,
  snippetValue,
  stringValue,
  tiktokPixelIdValue,
} from "./settings-mutations.ts";
import { permittedRole } from "./settings-team-mutations.ts";

describe("isPermittedScalar", () => {
  it("accepts strings, numbers, booleans and nil, and rejects arrays and hashes", () => {
    for (const value of ["a", 1, 1.5, true, false, null]) expect(isPermittedScalar(value)).toBe(true);
    for (const value of [[], ["a"], {}, { a: 1 }]) expect(isPermittedScalar(value)).toBe(false);
  });
});

describe("stringValue", () => {
  it("casts booleans to 1/0 for a varchar column and t/f for a text one, and integers to their digits", () => {
    expect(stringValue(true)).toBe("1");
    expect(stringValue(false)).toBe("0");
    expect(stringValue(true, "varchar")).toBe("1");
    expect(stringValue(true, "text")).toBe("t");
    expect(stringValue(false, "text")).toBe("f");
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

describe("snippetValue", () => {
  it("keeps strings, nil, integers and booleans as sent for the model to cast", () => {
    expect(snippetValue("<script></script>")).toBe("<script></script>");
    expect(snippetValue(null)).toBeNull();
    expect(snippetValue(4242)).toBe(4242);
    expect(snippetValue(true)).toBe(true);
    expect(snippetValue(false)).toBe(false);
  });

  it("hands back a bare non-integer number", () => {
    expect(() => snippetValue(1.5)).toThrow(HandBackToRails);
  });

  it("keeps a float and an integer past 2**53 as sent, id included", () => {
    expect(snippetValue(new RubyFloat(1.5))).toEqual(new RubyFloat(1.5));
    expect(snippetValue(12345678901234567890n)).toBe(12345678901234567890n);
    expect(() => snippetValue(new RubyFloat(Number.POSITIVE_INFINITY))).toThrow(HandBackToRails);
  });
});

describe("floats in a JSON body", () => {
  const body = (text: string) => new TextEncoder().encode(text);

  it("keeps each number written with a point or an exponent as a RubyFloat and the others as numbers", () => {
    const parsed = parseBody("application/json", body('{"a":1.0,"b":1,"c":1e2,"d":-0.5,"e":[2.5],"f":"1.0"}'), true);
    expect(parsed.a).toEqual(new RubyFloat(1));
    expect(parsed.b).toBe(1);
    expect(parsed.c).toEqual(new RubyFloat(100));
    expect(parsed.d).toEqual(new RubyFloat(-0.5));
    expect(parsed.e).toEqual([new RubyFloat(2.5)]);
    expect(parsed.f).toBe("1.0");
  });

  it("leaves every number a plain number without the flag", () => {
    expect(parseBody("application/json", body('{"a":1.0,"b":2.5}'))).toEqual({ a: 1, b: 2.5 });
  });

  it("casts a float to its Float#to_s for a string column, even when it is whole", () => {
    expect(stringValue(new RubyFloat(12.5))).toBe("12.5");
    expect(stringValue(new RubyFloat(7))).toBe("7.0");
    expect(stringValue(new RubyFloat(1e20), "text")).toBe("1.0e+20");
    expect(stringValue(new RubyFloat(0.0001))).toBe("0.0001");
    expect(isPermittedScalar(new RubyFloat(1))).toBe(true);
  });

  it("keeps a float TikTok pixel id for the model to fail on", () => {
    expect(tiktokPixelIdValue(new RubyFloat(5))).toEqual(new RubyFloat(5));
  });

  it("keeps an integer past 2**53 as a bigint, with every digit, and casts it to its digits for a string column", () => {
    const parsed = parseBody(
      "application/json",
      body('{"a":12345678901234567890,"b":-12345678901234567890,"c":9007199254740991}'),
      true,
    );
    expect(parsed).toEqual({ a: 12345678901234567890n, b: -12345678901234567890n, c: 9007199254740991 });
    expect(stringValue(12345678901234567890n)).toBe("12345678901234567890");
    expect(isPermittedScalar(12345678901234567890n)).toBe(true);
    expect(tiktokPixelIdValue(12345678901234567890n)).toBe(12345678901234567890n);
    expect(snippetValue(12345678901234567890n)).toBe(12345678901234567890n);
    expect(trueValue(12345678901234567890n)).toBe(false);
  });

  it("reads only the float 1.0 as a true flag value", () => {
    expect(trueValue(new RubyFloat(1))).toBe(true);
    for (const value of [new RubyFloat(0), new RubyFloat(0.5), new RubyFloat(2), 0, false, "0"]) {
      expect(trueValue(value)).toBe(false);
    }
    for (const value of [true, 1, "1", "t", "true"]) expect(trueValue(value)).toBe(true);
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

  it("answers a missing team_membership key with ParameterMissing and hands back an empty hash", () => {
    expect(() => permittedRole({})).toThrow(ParameterMissing);
    expect(() => permittedRole({ team_membership: {} })).toThrow(HandBackToRails);
  });

  it("casts a scalar role that is not a string, which the inclusion validation then refuses", () => {
    expect(permittedRole({ team_membership: { role: 5 } })).toEqual({ role: "5" });
    expect(permittedRole({ team_membership: { role: true } })).toEqual({ role: "true" });
    expect(permittedRole({ team_membership: { role: null } })).toEqual({ role: null });
  });
});
