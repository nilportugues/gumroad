// The shapes `assertSupported` refuses that the golden cannot record: Rails raises while rendering a gift or a
// preorder without the rows that go with it, so there is no message to compare. The refusal itself is a pure
// function of the rows, checked here; receipt-mailer.test.ts replays everything Rails renders.
import { describe, expect, it } from "vitest";

import { MailViewNotPortedError } from "../views.ts";
import { assertSupported, autoLinkText, mailSubject, type ReceiptData, simpleFormat } from "./receipt-presenter.ts";

const data = (purchase: Partial<ReceiptData["purchase"]> = {}, link: Partial<ReceiptData["link"]> = {}, seller: Partial<ReceiptData["seller"]> = {}): ReceiptData => ({
  purchase: {
    id: 401, link_id: 301, seller_id: 201, purchaser_id: null, email: "buyer@example.com", flags: 0, purchase_state: "successful", price_cents: 500, total_transaction_cents: 500,
    displayed_price_cents: 500, displayed_price_currency_type: "usd", rate_converted_to_usd: "1", shipping_cents: 0, tax_cents: 0, gumroad_tax_cents: 0, zip_tax_rate_id: null, quantity: 1, created_at: new Date("2026-10-31T12:00:00Z"),
    subscription_id: null, preorder_id: null, price_id: null, card_type: null, card_visual: null, full_name: null, street_address: null, city: null, state: null, zip_code: null, country: null,
    offer_code_id: null, ...purchase,
  },
  link: { id: 301, user_id: 201, name: "Guide", unique_permalink: "guide", custom_permalink: null, support_email: null, json_data: null, flags: 0, native_type: "digital", price_currency_type: "usd", require_shipping: false, ...link },
  seller: { id: 201, name: "Seller", username: "seller", email: "seller@example.com", unconfirmed_email: null, support_email: null, external_id: "8000000000201", recommendation_type: "no_recommendations", ...seller },
  displayedPriceUsdCents: 500, presentment: null, taxLines: null, urlRedirectToken: null, licenseKey: null, variantNames: null, tipValueCents: null, customFields: [], refundPolicy: null,
});

describe("assertSupported", () => {
  it("accepts a plain successful USD purchase", () => {
    expect(() => assertSupported(data())).not.toThrow();
  });

  it("accepts a purchase in another currency with a rate, and a seller recommending their own products", () => {
    expect(() => assertSupported(data({ displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" }))).not.toThrow();
    expect(() => assertSupported(data({}, {}, { recommendation_type: "own_products" }))).not.toThrow();
  });

  const refused: [string, ReturnType<typeof data>][] = [
    ["a gift the buyer sent", data({ flags: 1 << 6 })],
    ["a gift the buyer received", data({ flags: 1 << 5 })],
    ["a preorder authorization", data({ flags: 1 << 3 })],
    ["a preorder", data({ preorder_id: 9 })],
    ["a subscription purchase", data({ subscription_id: 9 })],
    ["a membership product", data({}, { flags: 1 << 1 })],
    ["a free trial", data({ flags: 1 << 18 })],
    ["a rental", data({ flags: 1 << 14 })],
    ["a bundle", data({ flags: 1 << 25 })],
    ["a purchase that is not successful", data({ purchase_state: "failed" })],
    ["a purchase priced in euros without a stored rate", data({ displayed_price_currency_type: "eur", rate_converted_to_usd: null })],
    ["a purchase priced in a currency the money gem does not know", data({ displayed_price_currency_type: "xxx", rate_converted_to_usd: "1.0" })],
    ["a call", data({}, { native_type: "call" })],
    ["the seller buying their own product", data({ purchaser_id: 201 })],
    ["a seller who recommends affiliate products", data({}, {}, { recommendation_type: "gumroad_affiliates_products" })],
  ];
  for (const [name, row] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => assertSupported(row)).toThrow(MailViewNotPortedError);
    });
  }
});

describe("mailSubject", () => {
  it("names the product and tells a free one from a paid one", () => {
    expect(mailSubject(data())).toBe("You bought Guide!");
    expect(mailSubject(data({ price_cents: 0 }))).toBe("You got Guide!");
  });
});

describe("text that goes through rails_autolink and the sanitizer", () => {
  it("escapes plain text and refuses anything the port cannot match", () => {
    expect(autoLinkText(`Tom & Jerry's "pick"`)).toBe("Tom &amp; Jerry&#39;s &quot;pick&quot;");
    for (const text of ["see https://example.com", "mail me@example.com", "www.example.com", "<b>bold</b>", "café", "&amp;"]) {
      expect(() => autoLinkText(text)).toThrow(MailViewNotPortedError);
    }
  });

  it("splits paragraphs on blank lines and breaks single newlines", () => {
    expect(simpleFormat("one\ntwo\n\nthree")).toBe("<p>one\n<br />two</p>\n\n<p>three</p>");
  });
});
