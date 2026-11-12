import { describe, expect, it } from "vitest";

import { cleanPriceCents, parseCreateParams, toSentence } from "./link-create.ts";
import { NotPortedError } from "./user.ts";

describe("cleanPriceCents", () => {
  it.each([
    ["5", 500n],
    ["5+", 500n],
    ["$1,234.50", 123_450n],
    ["5,50", 550n],
    ["12.345", 1235n],
    ["0.994", 99n],
    ["-5", -500n],
    ["1.2.3", 123n],
    ["free", 0n],
    ["", 0n],
  ])("reads %j as %s cents", (text, cents) => {
    expect(cleanPriceCents(text)).toBe(cents);
  });

  it("reads yen without cents or comma handling", () => {
    expect(cleanPriceCents("1,500", true)).toBe(1500n);
    expect(cleanPriceCents("500.5", true)).toBe(501n);
  });

  it("refuses text BigDecimal would raise on", () => {
    expect(() => cleanPriceCents("1-2")).toThrow(NotPortedError);
  });
});

describe("toSentence", () => {
  it("joins the way Rails' default locale does", () => {
    expect(toSentence([])).toBe("");
    expect(toSentence(["a"])).toBe("a");
    expect(toSentence(["a", "b"])).toBe("a and b");
    expect(toSentence(["a", "b", "c"])).toBe("a, b, and c");
  });
});

describe("parseCreateParams", () => {
  const form = { name: "Book", price_range: "5", native_type: "digital", price_currency_type: "usd" };

  it("accepts the form of a USD digital product", () => {
    expect(parseCreateParams({ ...form, is_physical: false, ai_prompt: "", custom_summary: null })).toEqual({
      name: "Book",
      priceRange: "5",
      nativeType: "digital",
      description: null,
      currency: "usd",
      isPhysical: false,
      subscriptionDuration: null,
      customSummary: null,
    });
  });

  it("reads a membership, a lowercase currency, a custom summary and a missing price", () => {
    const membership = {
      ...form,
      native_type: "membership",
      is_recurring_billing: true,
      subscription_duration: "yearly",
    };
    expect(parseCreateParams({ ...membership, price_currency_type: "EUR", custom_summary: "Short" })).toMatchObject({
      currency: "eur",
      subscriptionDuration: "yearly",
      customSummary: "Short",
    });
    expect(parseCreateParams({ ...form, price_range: undefined, custom_summary: "  " })).toMatchObject({
      priceRange: null,
      customSummary: null,
    });
  });

  it.each([
    ["the string false for is_physical, which Rails reads as true", { is_physical: "false" }],
    ["a physical membership", { is_physical: true, native_type: "membership", is_recurring_billing: true }],
    ["a recurring digital product", { is_recurring_billing: true }],
    ["a membership that is not recurring", { native_type: "membership" }],
    [
      "an unknown subscription duration",
      { native_type: "membership", is_recurring_billing: true, subscription_duration: "weekly" },
    ],
    ["a currency without configuration", { price_currency_type: "xyz" }],
    ["a membership in yen", { native_type: "membership", is_recurring_billing: true, price_currency_type: "jpy" }],
    ["an AI prompt", { ai_prompt: "write it" }],
    ["a custom summary without a price", { custom_summary: "x", price_range: null }],
    ["a native type that is not served", { native_type: "call" }],
    ["a permitted attribute the form never sends", { unique_permalink: "abc" }],
    ["an exponent price", { price_range: 1e21 }],
  ])("hands back %s", (_name, extra) => {
    expect(() => parseCreateParams({ ...form, ...extra })).toThrow(NotPortedError);
  });

  it("drops the attributes link_params does not permit", () => {
    expect(() =>
      parseCreateParams({ ...form, number_of_content_pages: 3, release_at_date: "2026-01-01" }),
    ).not.toThrow();
  });
});
