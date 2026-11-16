import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import {
  cartChanges,
  lineChanges,
  readPlan,
  type CartRow,
  type LineRow,
  type PlannedLine,
} from "./checkout-cart-save.ts";

const item = (extra: Record<string, unknown> = {}) => ({
  product: { id: "abc==" },
  price: 500,
  quantity: 1,
  referrer: "direct",
  url_parameters: {},
  ...extra,
});
const plan = (cart: unknown) => readPlan({ cart });
const lines = (cart: unknown) => {
  const result = plan(cart);
  if ("alert" in result) throw new Error(result.alert);
  return result.lines;
};

describe("CheckoutController#update request reading", () => {
  it.each([undefined, null, "foo", 4, true, []])("redirects a cart that is %j with the generic alert", (cart) => {
    expect(plan(cart)).toEqual({ alert: "Sorry, something went wrong. Please try again." });
  });

  it("redirects more than 50 lines with the limit alert before looking at the lines", () => {
    const result = plan({ items: Array.from({ length: 51 }, () => ({})) });
    expect(result).toEqual({ alert: "You cannot add more than 50 products to the cart." });
  });

  it.each([
    { product: undefined },
    { product: null },
    { product: "abc==" },
    { product: {} },
    { product: { id: "" } },
    { product: { id: ["a"] } },
  ])("redirects a line with product %j with the missing product alert", (extra) => {
    const result = plan({ items: [{ ...item(), ...extra }] });
    expect(result).toEqual({ alert: "A product in your cart is missing. Refresh the page and try again." });
  });

  it("reads the cart level fields and drops extra discount code keys", () => {
    const result = plan({
      email: "a@example.com",
      returnUrl: "https://example.com",
      rejectPppDiscount: true,
      discountCodes: [{ code: "X", fromUrl: true, extra: 1 }],
      items: [],
    });
    expect(result).toEqual({
      email: "a@example.com",
      returnUrl: "https://example.com",
      rejectPppDiscount: true,
      discountCodes: [{ code: "X", fromUrl: true }],
      lines: [],
    });
  });

  it("treats a blank email as none and a missing discount code list as empty", () => {
    expect(plan({ email: "  ", items: [] })).toMatchObject({
      email: null,
      discountCodes: [],
      rejectPppDiscount: false,
      returnUrl: null,
    });
  });

  it("drops lines with a quantity of 0, number or string", () => {
    expect(lines({ items: [item({ quantity: 0 }), item({ quantity: "0" })] })).toEqual([]);
  });

  it("casts a numeric price and quantity written as strings", () => {
    expect(lines({ items: [item({ price: "700", quantity: "3" })] })[0]).toMatchObject({ price: 700n, quantity: 3 });
  });

  it("leaves url parameters and referrer alone when the line sends none", () => {
    const [line] = lines({ items: [{ product: { id: "abc==" }, price: 1, quantity: 1 }] });
    expect(line).toMatchObject({ urlParameters: undefined, referrer: undefined });
  });

  it.each([
    ["a negative quantity", { quantity: -1 }],
    ["a fractional quantity", { quantity: 0.5 }],
    ["a quantity above the column", { quantity: 2_147_483_648 }],
    ["a word for a quantity", { quantity: "abc" }],
    ["a quantity with a leading zero", { quantity: "010" }],
    ["a missing quantity", { quantity: undefined }],
    ["a negative price", { price: -5 }],
    ["a missing price", { price: undefined }],
    ["a blank price", { price: "" }],
    ["an affiliate", { affiliate_id: 12 }],
    ["an accepted offer", { accepted_offer: { id: "x" } }],
    ["a call start time", { call_start_time: "2030-01-01T00:00:00Z" }],
    ["installments", { pay_in_installments: true }],
    ["installments written as a string", { pay_in_installments: "" }],
    ["url parameters that are not strings", { url_parameters: { count: 3 } }],
    ["a blank referrer", { referrer: " " }],
    ["a rent flag that is a word", { rent: "yes" }],
    ["a recurrence longer than its column", { recurrence: "x".repeat(256) }],
  ])("hands back a line with %s", (_name, extra) => {
    expect(() => lines({ items: [item(extra)] })).toThrow(HandBackToRails);
  });

  it.each([
    ["discount codes without fromUrl", { discountCodes: [{ code: "A" }] }],
    ["discount codes that are not a list", { discountCodes: "A" }],
    ["an email that is not text", { email: 4 }],
    ["a PPP flag that is not a boolean", { rejectPppDiscount: "true" }],
    ["items that are not a list", { items: { 0: item() } }],
    ["an empty cart object", {}],
  ])("hands back a cart with %s", (_name, cart) => {
    expect(() => plan(Object.keys(cart).length === 0 ? cart : { items: [], ...cart })).toThrow(HandBackToRails);
  });
});

const cartRow = (extra: Partial<CartRow> = {}): CartRow => ({
  id: 1n,
  return_url: null,
  discount_codes: [],
  reject_ppp_discount: 0,
  email: null,
  browser_guid: "g",
  ip_address: "127.0.0.1",
  ...extra,
});
const values = {
  email: null,
  returnUrl: null,
  rejectPppDiscount: false,
  discountCodes: [],
  ip: "127.0.0.1",
  guid: "g",
};

describe("cart columns ActiveRecord would write", () => {
  it("writes nothing when every column is the same", () => {
    expect(cartChanges(cartRow(), values)).toEqual([]);
  });

  it("writes the columns that differ", () => {
    expect(
      cartChanges(cartRow(), {
        ...values,
        email: "a@example.com",
        rejectPppDiscount: true,
        ip: "10.0.0.1",
        guid: "new",
      }).map(([name]) => name),
    ).toEqual(["ip_address", "browser_guid", "email", "reject_ppp_discount"]);
  });

  it("compares discount codes as JSON text or parsed, whatever the key order", () => {
    const row = cartRow({ discount_codes: '[{"fromUrl":false,"code":"A"}]' });
    expect(cartChanges(row, { ...values, discountCodes: [{ code: "A", fromUrl: false }] })).toEqual([]);
    expect(cartChanges(row, { ...values, discountCodes: [{ code: "A", fromUrl: true }] })).toEqual([
      ["discount_codes", [{ code: "A", fromUrl: true }]],
    ]);
  });

  it("rewrites a NULL discount_codes as []", () => {
    expect(cartChanges(cartRow({ discount_codes: null }), values)).toEqual([["discount_codes", []]]);
  });
});

const lineRow = (extra: Partial<LineRow> = {}): LineRow => ({
  id: 1n,
  product_id: 1n,
  option_id: null,
  affiliate_id: null,
  accepted_offer_id: null,
  price: 500,
  quantity: 1,
  recurrence: null,
  recommended_by: null,
  rent: 0,
  url_parameters: {},
  referrer: "direct",
  recommender_model_name: null,
  call_start_time: null,
  accepted_offer_details: {},
  pay_in_installments: 0,
  ...extra,
});
const planned = (extra: Partial<PlannedLine> = {}): PlannedLine => ({
  productId: 1n,
  optionId: null,
  price: 500n,
  quantity: 1,
  recurrence: null,
  recommendedBy: null,
  rent: false,
  urlParameters: {},
  referrer: "direct",
  recommenderModelName: null,
  externalProductId: "abc==",
  externalOptionId: null,
  ...extra,
});

describe("cart line columns ActiveRecord would write", () => {
  it("writes nothing when the line is the same", () => {
    expect(lineChanges(lineRow(), planned())).toEqual([]);
  });

  it("writes only the columns that differ", () => {
    expect(lineChanges(lineRow(), planned({ price: 600n, quantity: 2, rent: true })).map(([name]) => name)).toEqual([
      "price",
      "quantity",
      "rent",
    ]);
  });

  it("clears an affiliate, an accepted offer and a call start time the line no longer carries", () => {
    const row = lineRow({
      affiliate_id: 3n,
      accepted_offer_id: 4n,
      accepted_offer_details: { original_product_id: "x" },
      call_start_time: new Date(),
      pay_in_installments: 1,
    });
    expect(lineChanges(row, planned()).map(([name]) => name)).toEqual([
      "affiliate_id",
      "accepted_offer_id",
      "accepted_offer_details",
      "call_start_time",
      "pay_in_installments",
    ]);
  });

  it("keeps url parameters and referrer the line does not send", () => {
    expect(
      lineChanges(lineRow({ url_parameters: { a: "b" } }), planned({ urlParameters: undefined, referrer: undefined })),
    ).toEqual([]);
  });

  it("rewrites NULL JSON columns as {}", () => {
    const names = lineChanges(
      lineRow({ url_parameters: null, accepted_offer_details: null }),
      planned({ urlParameters: undefined }),
    ).map(([name]) => name);
    expect(names).toEqual(["url_parameters", "accepted_offer_details"]);
  });
});
