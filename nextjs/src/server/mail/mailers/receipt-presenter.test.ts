// The shapes `assertSupported` refuses that the golden cannot record: Rails raises while rendering a gift or a
// preorder without the rows that go with it, so there is no message to compare. The refusal itself is a pure
// function of the rows, checked here; receipt-mailer.test.ts replays everything Rails renders.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailViewNotPortedError } from "../views.ts";

import {
  assertSupported,
  autoLinkText,
  chargeInfo,
  itemInfo,
  mailSubject,
  type ReceiptData,
  simpleFormat,
  unproven,
} from "./receipt-presenter.ts";

const data = (
  purchase: Partial<ReceiptData["purchase"]> = {},
  link: Partial<ReceiptData["link"]> = {},
  seller: Partial<ReceiptData["seller"]> = {},
): ReceiptData => ({
  purchase: {
    id: 401,
    link_id: 301,
    seller_id: 201,
    purchaser_id: null,
    email: "buyer@example.com",
    flags: 0,
    purchase_state: "successful",
    price_cents: 500,
    total_transaction_cents: 500,
    displayed_price_cents: 500,
    displayed_price_currency_type: "usd",
    rate_converted_to_usd: "1",
    shipping_cents: 0,
    tax_cents: 0,
    gumroad_tax_cents: 0,
    zip_tax_rate_id: null,
    quantity: 1,
    created_at: new Date("2026-10-31T12:00:00Z"),
    subscription_id: null,
    preorder_id: null,
    price_id: null,
    card_type: null,
    card_visual: null,
    full_name: null,
    street_address: null,
    city: null,
    state: null,
    zip_code: null,
    country: null,
    offer_code_id: null,
    ...purchase,
  },
  link: {
    id: 301,
    user_id: 201,
    name: "Guide",
    unique_permalink: "guide",
    custom_permalink: null,
    support_email: null,
    json_data: null,
    flags: 0,
    native_type: "digital",
    price_currency_type: "usd",
    require_shipping: false,
    ...link,
  },
  seller: {
    id: 201,
    name: "Seller",
    username: "seller",
    email: "seller@example.com",
    unconfirmed_email: null,
    support_email: null,
    external_id: "8000000000201",
    recommendation_type: "no_recommendations",
    ...seller,
  },
  displayedPriceUsdCents: 500,
  presentment: null,
  taxLines: null,
  urlRedirectToken: null,
  urlRedirectIsRental: false,
  linkStreamable: null,
  licenseKey: null,
  variantNames: null,
  tipValueCents: null,
  customFields: [],
  refundPolicy: null,
  gift: null,
});

describe("assertSupported", () => {
  it("accepts a plain successful USD purchase", () => {
    expect(() => assertSupported(data())).not.toThrow();
  });

  it("accepts a purchase in another currency with a rate, and a seller recommending their own products", () => {
    expect(() =>
      assertSupported(data({ displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" })),
    ).not.toThrow();
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
    ["a bundle", data({ flags: 1 << 25 })],
    ["a purchase that is not successful", data({ purchase_state: "failed" })],
    [
      "a purchase priced in euros without a stored rate",
      data({ displayed_price_currency_type: "eur", rate_converted_to_usd: null }),
    ],
    [
      "a purchase priced in a currency the money gem does not know",
      data({ displayed_price_currency_type: "xxx", rate_converted_to_usd: "1.0" }),
    ],
    ["a call", data({}, { native_type: "call" })],
    ["the seller buying their own product", data({ purchaser_id: 201 })],
    [
      "a seller who recommends affiliate products",
      data({}, {}, { recommendation_type: "gumroad_affiliates_products" }),
    ],
  ];
  for (const [name, row] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => assertSupported(row)).toThrow(MailViewNotPortedError);
    });
  }
});

describe("rental receipts", () => {
  const rental = data({ flags: 1 << 14 });

  it("accepts a rental purchase", () => {
    expect(() => assertSupported(rental)).not.toThrow();
  });

  it("names the rental in the subject and adds the expiry note", () => {
    expect(mailSubject(rental)).toBe("You rented Guide!");
    expect(mailSubject(data({ flags: 1 << 14, price_cents: 0 }))).toBe("You rented Guide!");
    expect(itemInfo(rental, null).notes).toEqual([
      "Your rental of Guide will expire in 30 days or 72 hours after you begin viewing it.",
    ]);
  });

  // UNPROVEN against Ruby: see receipt_rental_no_video and receipt_rental_watch in generate-receipt-mailer-golden.rb.
  it("offers View content for a non-rental redirect, Watch for a rental redirect with a video, and no button otherwise", () => {
    const withToken = (extra: Partial<ReceiptData>): ReceiptData => ({ ...rental, urlRedirectToken: "tok", ...extra });
    expect(itemInfo(withToken({}), null).downloadCta).toEqual({ label: null, path: "/d/tok" });
    expect(itemInfo(withToken({ urlRedirectIsRental: true, linkStreamable: true }), null).downloadCta).toEqual({
      label: "Watch",
      path: "/s/tok",
    });
    expect(itemInfo(withToken({ urlRedirectIsRental: true, linkStreamable: false }), null).downloadCta).toBeNull();
  });
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
    for (const text of [
      "see https://example.com",
      "mail me@example.com",
      "www.example.com",
      "<b>bold</b>",
      "café",
      "&amp;",
    ]) {
      expect(() => autoLinkText(text)).toThrow(MailViewNotPortedError);
    }
  });

  it("splits paragraphs on blank lines and breaks single newlines", () => {
    expect(simpleFormat("one\ntwo\n\nthree")).toBe("<p>one\n<br />two</p>\n\n<p>three</p>");
  });
});

describe("gift the buyer sent", () => {
  const sent = (
    gift: Partial<NonNullable<ReceiptData["gift"]>> = {},
    extra: Partial<ReceiptData> = {},
  ): ReceiptData => ({
    ...data({ flags: 1 << 6, quantity: 2 }),
    urlRedirectToken: "tok",
    gift: { giftee_email: "friend@example.com", gift_note: "  Enjoy!\n", flags: 0, ...gift },
    ...extra,
  });
  afterEach(() => {
    unproven.giftSender = true;
  });

  it("goes back to Rails while unproven", () => {
    expect(() => assertSupported(sent())).toThrow(MailViewNotPortedError);
  });

  describe("once proven", () => {
    beforeEach(() => {
      unproven.giftSender = false;
    });

    it("accepts a plain gift and names the giftee in the subject", () => {
      expect(() => assertSupported(sent())).not.toThrow();
      expect(mailSubject(sent())).toBe("You bought friend@example.com Guide!");
    });

    it("lists the giftee and the stripped message, hides the download button and the quantity, and drops the questions note", () => {
      const item = itemInfo(sent(), null);
      expect(item.giftAttributes).toEqual([
        { label: "Gift sent to", text: "friend@example.com" },
        { label: "Message", text: "Enjoy!" },
      ]);
      expect(item.showDownloadButton).toBe(false);
      expect(item.generalAttributes.map((attribute) => attribute.label)).not.toContain("Quantity");
      expect(chargeInfo(sent(), "abc").productQuestionsNote).toBeNull();
    });

    it("omits the message when the note is blank", () => {
      expect(itemInfo(sent({ gift_note: " \n" }), null).giftAttributes).toEqual([
        { label: "Gift sent to", text: "friend@example.com" },
      ]);
    });

    it("refuses a hidden recipient, a missing gift row, and a physical or licensed gift", () => {
      expect(() => assertSupported(sent({ flags: 1 }))).toThrow(MailViewNotPortedError);
      expect(() => assertSupported(sent({}, { gift: null }))).toThrow(MailViewNotPortedError);
      expect(() => assertSupported({ ...sent(), link: { ...sent().link, flags: 1 << 7 } })).toThrow(
        MailViewNotPortedError,
      );
    });
  });
});
