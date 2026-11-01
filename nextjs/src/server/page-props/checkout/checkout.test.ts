import { describe, expect, it } from "vitest";

import { cartProps, cartStateOf, emptyCartPaymentProps, savedCardProps, storedDiscountCodeCount, type CartRow } from "./checkout.ts";

const card = { card_type: "visa", visual: "**** **** **** 4242", expiry_month: 3, expiry_year: 2031, card_country: "US", payment_method_type: null };
const cartRow = (overrides: Partial<CartRow> = {}): CartRow => ({ id: 1n, email: null, return_url: null, reject_ppp_discount: 0, discount_codes: [], browser_guid: "g", user_id: null, ...overrides });

describe("savedCardProps", () => {
  it("zero-pads the month and keeps the last two digits of the year", () => {
    expect(savedCardProps(card)).toEqual({ type: "visa", number: "**** **** **** 4242", expiration_date: "03/31", requires_mandate: false });
  });

  it("requires a mandate for an Indian card, but not for UPI", () => {
    expect(savedCardProps({ ...card, card_country: "IN" }).requires_mandate).toBe(true);
    expect(savedCardProps({ ...card, card_country: "IN", card_type: "upi" }).requires_mandate).toBe(false);
    expect(savedCardProps({ ...card, card_country: "IN", payment_method_type: "upi" }).requires_mandate).toBe(false);
  });

  it("has no expiry date without a month or year", () => {
    expect(savedCardProps({ ...card, expiry_year: null }).expiration_date).toBeNull();
  });
});

describe("cart", () => {
  it("presents blank emails and return urls the way CartPresenter does", () => {
    expect(cartStateOf(cartRow({ email: " ", return_url: "" }))).toEqual({ email: null, returnUrl: "", rejectPppDiscount: false });
    expect(cartProps(cartStateOf(cartRow({ email: "a@example.com", reject_ppp_discount: 1 })))).toEqual({
      email: "a@example.com",
      returnUrl: "",
      rejectPppDiscount: true,
      discountCodes: [],
      items: [],
    });
    expect(cartProps(null)).toBeNull();
  });

  it("counts the stored discount codes whether the driver parses the JSON column or not", () => {
    expect(storedDiscountCodeCount(cartRow({ discount_codes: null }))).toBe(0);
    expect(storedDiscountCodeCount(cartRow({ discount_codes: [{ code: "A", fromUrl: false }] }))).toBe(1);
    expect(storedDiscountCodeCount(cartRow({ discount_codes: "[]" }))).toBe(0);
  });
});

describe("emptyCartPaymentProps", () => {
  it("falls back to the card element for an empty cart", () => {
    expect(emptyCartPaymentProps()).toMatchObject({ integration: "card_element", fallback_reason: "empty_cart", elements_options: null });
  });
});
