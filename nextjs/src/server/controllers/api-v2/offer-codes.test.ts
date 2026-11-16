import { describe, expect, it } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws-rb-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const { HandBackToRails } = await import("../application-controller.ts");
const { present, registeredApiV2Routes } = await import("./base.ts");
const { validityPeriodError, validityPeriodOf } = await import("./offer-codes.ts");
await import("./index.ts");

const messageOf = (params: Record<string, unknown>) => {
  const rendered = validityPeriodError(params);
  return rendered === undefined
    ? undefined
    : (JSON.parse(rendered.body as string) as { success: boolean; message: string });
};

describe("validityPeriodError", () => {
  it("accepts absent, null and empty periods", () => {
    expect(validityPeriodError({})).toBeUndefined();
    expect(validityPeriodError({ valid_at: null, expires_at: "" })).toBeUndefined();
  });

  it("accepts an RFC 3339 timestamp with a zone, a lowercase t and an offset", () => {
    expect(
      validityPeriodError({ valid_at: "2099-01-01T10:00:00Z", expires_at: "2099-02-01t10:00:00.5+02:00" }),
    ).toBeUndefined();
  });

  it("names the key whose value is not a timestamp", () => {
    expect(messageOf({ valid_at: "tomorrow" })).toEqual({
      success: false,
      message: "valid_at must be an RFC 3339 timestamp with a time zone, or null.",
    });
    expect(messageOf({ expires_at: "2099-01-01T10:00:00" })?.message).toBe(
      "expires_at must be an RFC 3339 timestamp with a time zone, or null.",
    );
  });

  it("names valid_at before expires_at when both are wrong", () => {
    expect(messageOf({ expires_at: "later", valid_at: "2099-13-01T10:00:00Z" })?.message).toMatch(/^valid_at /u);
  });

  it("refuses a value that is not a string", () => {
    expect(messageOf({ valid_at: 5 })?.success).toBe(false);
    expect(messageOf({ valid_at: true })?.success).toBe(false);
    expect(messageOf({ valid_at: ["2099-01-01T10:00:00Z"] })?.success).toBe(false);
  });

  it("refuses a day the month does not have, hour 24 and a leap second", () => {
    expect(messageOf({ valid_at: "2099-02-30T10:00:00Z" })?.success).toBe(false);
    expect(messageOf({ valid_at: "2099-01-01T24:00:00Z" })?.success).toBe(false);
    expect(messageOf({ valid_at: "2099-01-01T10:00:60Z" })?.success).toBe(false);
  });

  it("counts February 29 only in a leap year", () => {
    expect(validityPeriodError({ valid_at: "2096-02-29T10:00:00Z" })).toBeUndefined();
    expect(messageOf({ valid_at: "2099-02-29T10:00:00Z" })?.success).toBe(false);
    expect(messageOf({ valid_at: "2100-02-29T10:00:00Z" })?.success).toBe(false);
  });

  it("refuses minutes out of range, with or without a fraction or an offset", () => {
    const message = "valid_at must be an RFC 3339 timestamp with a time zone, or null.";
    expect(messageOf({ valid_at: "2099-01-01T10:75:00Z" })).toEqual({ success: false, message });
    expect(messageOf({ valid_at: "2099-01-01T10:60:00Z" })?.message).toBe(message);
    expect(messageOf({ valid_at: "2099-01-01T10:99:00.5+02:00" })?.message).toBe(message);
    expect(messageOf({ valid_at: "2099-01-01T10:00:00Z", expires_at: "2099-01-01T10:75:00Z" })?.message).toMatch(
      /^expires_at /u,
    );
    expect(validityPeriodError({ valid_at: "2099-01-01T10:59:00Z" })).toBeUndefined();
  });

  it("hands back an offset Time.zone.rfc3339 reads as none and years the Julian calendar reads differently", () => {
    expect(() => validityPeriodError({ valid_at: "2099-01-01T10:00:00+25:00" })).toThrow(HandBackToRails);
    expect(() => validityPeriodError({ valid_at: "1500-01-01T10:00:00Z" })).toThrow(HandBackToRails);
  });
});

describe("validityPeriodOf", () => {
  it("truncates a fraction of a second to whole seconds instead of rounding it", () => {
    expect(validityPeriodOf({ valid_at: "2099-01-01T10:59:59.9Z", expires_at: "2099-02-01T08:00:00.5+02:00" })).toEqual(
      {
        valid_at: new Date("2099-01-01T10:59:59.000Z"),
        expires_at: new Date("2099-02-01T06:00:00.000Z"),
      },
    );
    expect(validityPeriodOf({ valid_at: "2099-01-01T10:59:59.999999999Z" }).valid_at?.toISOString()).toBe(
      "2099-01-01T10:59:59.000Z",
    );
  });

  it("reads whole seconds, offsets and blanks", () => {
    expect(validityPeriodOf({ valid_at: "2099-01-01T10:00:00-05:30", expires_at: "" })).toEqual({
      valid_at: new Date("2099-01-01T15:30:00.000Z"),
      expires_at: null,
    });
  });
});

describe("present", () => {
  it("follows Object#present? for parsed parameters", () => {
    expect([undefined, null, false, "", "  ", " ", [], {}].map(present)).toEqual(Array<boolean>(8).fill(false));
    expect(["0", 0, true, ["a"], { a: 1 }].map(present)).toEqual(Array<boolean>(5).fill(true));
  });
});

describe("the write routes of N through Z", () => {
  const registered = (method: string, pattern: string) =>
    registeredApiV2Routes().some((route) => route.method === method && route.pattern === pattern);

  it("registers the writes it answers or hands back", () => {
    for (const [method, pattern] of [
      ["POST", "/v2/products/:link_id/offer_codes"],
      ["PATCH", "/v2/offer_codes/:id"],
      ["PUT", "/v2/products/:link_id/offer_codes/:id"],
      ["DELETE", "/v2/products/:link_id/offer_codes/:id"],
      ["POST", "/v2/upsells"],
      ["DELETE", "/v2/upsells/:id"],
      ["PUT", "/v2/resource_subscriptions"],
      ["POST", "/v2/resource_subscriptions/:id/test_event"],
      ["POST", "/v2/products/:link_id/thumbnail"],
      ["DELETE", "/v2/products/:link_id/thumbnail"],
      ["POST", "/v2/products/:link_id/builds/deploy"],
      ["POST", "/v2/products/:link_id/builds/:id/promote"],
      ["GET", "/v2/tax_forms/:year/:tax_form_type/download"],
    ] as const) {
      expect(registered(method, pattern), `${method} ${pattern}`).toBe(true);
    }
  });
});
