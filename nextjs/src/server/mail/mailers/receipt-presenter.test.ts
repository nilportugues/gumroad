// The shapes `assertSupported` refuses that the golden cannot record: Rails raises while rendering a gift or a
// preorder without the rows that go with it, so there is no message to compare. The refusal itself is a pure
// function of the rows, checked here; receipt-mailer.test.ts replays everything Rails renders.
import { describe, expect, it } from "vitest";

import { MailViewNotPortedError } from "../views.ts";

import {
  assertSupported,
  autoLinkText,
  chargeInfo,
  itemInfo,
  mailSubject,
  type ReceiptData,
  simpleFormat,
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
  subscription: null,
  priceRecurrence: null,
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
    expect(autoLinkText("friend@example.com")).toBe(
      `<a href="mailto:friend@example.com" target="_blank">friend@example.com</a>`,
    );
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
  describe("as recorded from Rails", () => {
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

describe("gift the buyer received", () => {
  const received = (
    gift: Partial<NonNullable<ReceiptData["gift"]>> | null = {},
    purchase: Partial<ReceiptData["purchase"]> = {},
  ): ReceiptData => ({
    ...data({
      flags: 1 << 5,
      purchase_state: "gift_receiver_purchase_successful",
      price_cents: 0,
      total_transaction_cents: 0,
      displayed_price_cents: 0,
      ...purchase,
    }),
    gift:
      gift === null
        ? null
        : {
            giftee_email: "buyer@example.com",
            gift_note: "Enjoy!",
            flags: 0,
            gifter_email: "gifter@example.com",
            gifter_purchase_id: 402,
            ...gift,
          },
  });

  it("accepts the receiver's free purchase and names the gifter in the subject", () => {
    expect(() => assertSupported(received())).not.toThrow();
    expect(mailSubject(received())).toBe("gifter@example.com bought Guide for you!");
    expect(mailSubject(received({}, { full_name: "Gina Gifter" }))).toBe(
      "Gina Gifter (gifter@example.com) bought Guide for you!",
    );
    expect(mailSubject(received({ flags: 2 }, { full_name: "Gina Gifter" }))).toBe("Someone bought Guide for you!");
  });

  it("refuses what the golden does not record", () => {
    expect(() => assertSupported(received(null))).toThrow(MailViewNotPortedError);
    expect(() => assertSupported(received({ gifter_purchase_id: null }))).toThrow(MailViewNotPortedError);
    expect(() => assertSupported(received({ gifter_email: "" }))).toThrow(MailViewNotPortedError);
    expect(() => assertSupported(received({ flags: 1 }))).toThrow(MailViewNotPortedError);
    expect(() => assertSupported(received({ gifter_email: "a+b'c@example.com" }))).toThrow(MailViewNotPortedError);
    expect(() => assertSupported(received({}, { price_cents: 500 }))).toThrow(MailViewNotPortedError);
    expect(() => assertSupported(received({}, { purchase_state: "successful" }))).toThrow(MailViewNotPortedError);
    expect(() => assertSupported(received({}, { flags: (1 << 5) | (1 << 6) }))).toThrow(MailViewNotPortedError);
  });
});

describe("a membership's first receipt", () => {
  const ORIGINAL = 1 << 2;
  const TRIAL = 1 << 18;
  const member = (
    purchase: Partial<ReceiptData["purchase"]> = {},
    subscription: Partial<NonNullable<ReceiptData["subscription"]>["row"]> = {},
    link: Partial<ReceiptData["link"]> = {},
  ): ReceiptData => ({
    ...data(
      { flags: ORIGINAL, subscription_id: 501, price_id: 701, ...purchase },
      { flags: 1 << 1, native_type: "membership", ...link },
    ),
    subscription: {
      row: { id: 501, flags: 0, charge_occurrence_count: null, free_trial_ends_at: null, ...subscription },
      externalId: "EuU5qDog1TrOQS8nm-BKsA==",
      recurrence: "monthly",
      nextPayment: { cents: 500, date: new Date("2026-11-30T12:00:00Z") },
      gift: false,
    },
    priceRecurrence: "monthly",
  });

  it("accepts a monthly membership and its free trial", () => {
    expect(() => assertSupported(member())).not.toThrow();
    const trial = member(
      { flags: ORIGINAL | TRIAL, purchase_state: "not_charged", price_cents: 0 },
      { free_trial_ends_at: new Date("2026-11-07T12:00:00Z") },
    );
    expect(() => assertSupported(trial)).not.toThrow();
    expect(mailSubject(trial)).toBe("You've subscribed to Guide!");
  });

  it("refuses what renders other sections", () => {
    const refusals = [
      member({}, { charge_occurrence_count: 12 }),
      member({}, { flags: 1 << 6 }),
      member({}, { flags: 1 << 0 }),
      member({ flags: 0 }),
      member({ price_id: null }),
      member({ flags: ORIGINAL | (1 << 6) }),
      member({ flags: ORIGINAL | (1 << 5), purchase_state: "gift_receiver_purchase_successful" }),
      member({ flags: ORIGINAL | TRIAL }),
      member({ flags: ORIGINAL | TRIAL, purchase_state: "not_charged" }),
      member({ displayed_price_currency_type: "eur", rate_converted_to_usd: "0.9" }),
      member({}, {}, { price_currency_type: "eur" }),
      { ...member(), subscription: null },
    ];
    for (const refusal of refusals) expect(() => assertSupported(refusal)).toThrow(MailViewNotPortedError);
  });

  it("states the cadence on the price and the note, and a trial is not free", () => {
    const item = itemInfo(member(), null);
    expect(item.generalAttributes).toContainEqual({ label: "Product price", text: "$5 a month" });
    expect(item.manageSubscriptionNote).toContain("You will be charged once a month.");
    const trial = member({ flags: ORIGINAL | TRIAL, purchase_state: "not_charged", price_cents: 0 });
    expect(itemInfo(trial, null).notes).toEqual(["Your free trial has begun!"]);
    expect(chargeInfo(trial, "x").free).toBe(false);
    expect(chargeInfo(member({ price_cents: 0 }), "x").free).toBe(true);
  });
});
