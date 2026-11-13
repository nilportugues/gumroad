import type { Link, Purchase, User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/obfuscate-ids.ts", () => ({
  encrypt: (id: bigint | number) => `enc${id}`,
  encryptNumeric: (id: number) => id + 1000,
}));

const {
  linkAsJsonMobile,
  purchaseAsJsonCreatorApp,
  purchaseJsonDataForMobile,
  formattedDisplayPrice,
  formattedTotalPrice,
} = await import("./mobile-serializers.ts");
const { longFormattedDatetime } = await import("./mobile-time.ts");

const NOW = new Date("2026-11-02T15:00:00.000Z");
const { PurchaseFlags } = await import("../search/flags.ts");
const { LinkFlags } = await import("../models/link.ts");
const PHYSICAL_BIT = BigInt(LinkFlags.bit("is_physical"));
const IS_ARCHIVED_BIT = BigInt(PurchaseFlags.bit("is_archived"));
const IS_BUNDLE_PURCHASE_BIT = BigInt(PurchaseFlags.bit("is_bundle_purchase"));
const CHARGEBACK_REVERSED_BIT = BigInt(PurchaseFlags.bit("chargeback_reversed"));
const GIFT_SENDER_BIT = BigInt(PurchaseFlags.bit("is_gift_sender_purchase"));

const seller = {
  id: 7n,
  external_id: "sel7",
  timezone: "Pacific Time (US & Canada)",
  name: "Seller",
  username: "seller",
  flags: 0n,
} as unknown as User;
const buyer = { id: 8n, external_id: "buy8", email: "buyer@example.com", name: "Buyer" } as unknown as User;
const link = (overrides: Partial<Link> = {}) =>
  ({
    id: 3n,
    name: "Product",
    unique_permalink: "abc",
    description: "Desc",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00.123Z"),
    content_updated_at: null,
    flags: 0n,
    ...overrides,
  }) as unknown as Link;
const purchase = (overrides: Partial<Purchase> = {}) =>
  ({
    id: 11n,
    seller_id: 7n,
    purchaser_id: null,
    link_id: 3n,
    email: "buyer@example.com",
    full_name: " Jane Doe ",
    created_at: NOW,
    price_cents: 100,
    displayed_price_cents: 100,
    displayed_price_currency_type: "usd",
    fee_cents: 29,
    flags: 0n,
    quantity: 1,
    charge_processor_id: "stripe",
    stripe_refunded: null,
    stripe_partially_refunded: false,
    chargeback_date: null,
    price_id: null,
    subscription_id: null,
    ...overrides,
  }) as unknown as Purchase;
const mobileLinkInput = (overrides = {}) => ({
  link: link(),
  creator: seller,
  creatorAvatarUrl: "https://example.com/avatar.png",
  creatorProfileUrl: "https://seller.example.com",
  thumbnailOrCoverUrl: null,
  preview: null,
  ...overrides,
});
const creatorApp = (p: Purchase, l: Link = link()) =>
  purchaseAsJsonCreatorApp({
    purchase: p,
    link: l,
    seller,
    purchaser: null,
    productHasVariants: false,
    productThumbnailUrl: null,
    now: NOW,
  });

describe("formatted prices", () => {
  // spec/models/purchase/purchase_installments_spec.rb "creator api"
  it("formats a whole-dollar sale as $1 and a free one as $0", () => {
    expect(formattedDisplayPrice(purchase())).toBe("$1");
    expect(formattedDisplayPrice(purchase({ price_cents: 0, displayed_price_cents: 0 }))).toBe("$0");
  });

  it("keeps cents that are not whole and writes 99 cents as 99¢", () => {
    expect(formattedTotalPrice(purchase({ price_cents: 1250 }))).toBe("$12.50");
    expect(formattedDisplayPrice(purchase({ displayed_price_cents: 99 }))).toBe("99¢");
  });

  const EURO = { displayed_price_currency_type: "eur", rate_converted_to_usd: "0.81" };

  it("converts the USD total at the stored rate and leaves the displayed price in its own currency", () => {
    const euro = purchase({ ...EURO, price_cents: 1250, displayed_price_cents: 1000 });
    expect(formattedTotalPrice(euro)).toBe("€10.13");
    expect(formattedDisplayPrice(euro)).toBe("€10");
  });

  it("divides by 100 for a single-unit currency and groups its thousands", () => {
    const yen = purchase({
      displayed_price_currency_type: "jpy",
      rate_converted_to_usd: "150.0",
      price_cents: 1000,
      displayed_price_cents: 1500,
    });
    expect(formattedTotalPrice(yen)).toBe("¥1,500");
    expect(formattedDisplayPrice(yen)).toBe("¥1,500");
  });

  it("reads a rate of zero as zero, as String#to_f does", () => {
    expect(formattedTotalPrice(purchase({ ...EURO, rate_converted_to_usd: "oops" }))).toBe("€0");
  });

  it.each([
    ["a currency with no stored rate", { displayed_price_currency_type: "eur", rate_converted_to_usd: null }],
    ["a currency with a blank rate", { displayed_price_currency_type: "eur", rate_converted_to_usd: " " }],
    ["a currency the money gem does not know", { displayed_price_currency_type: "zzz", rate_converted_to_usd: "1.0" }],
    ["no currency", { displayed_price_currency_type: null }],
    ["a recurrence price", { price_id: 5n }],
    ["a subscription without a recurrence label", { subscription_id: 5n }],
  ])("refuses %s", (_name, overrides) => {
    expect(() => formattedDisplayPrice(purchase(overrides as Partial<Purchase>))).toThrow(/not ported/u);
  });
});

describe("formatted prices of a subscription purchase", () => {
  it("appends the recurrence label of the subscription's price", () => {
    const membership = purchase({ subscription_id: 5n, price_cents: 300, displayed_price_cents: 300 });
    expect(formattedTotalPrice(membership, "a month")).toBe("$3 a month");
    expect(formattedDisplayPrice(membership, "a month")).toBe("$3 a month");
  });

  it("still refuses a purchase with a price record of its own", () => {
    expect(() => formattedTotalPrice(purchase({ price_id: 5n, subscription_id: 5n }), "a month")).toThrow(/not ported/u);
  });
});

describe("longFormattedDatetime", () => {
  it("pads the day and hour with spaces in the seller's zone", () => {
    expect(longFormattedDatetime(NOW, "Pacific Time (US & Canada)")).toBe(" 2 Nov 2026  7:00 AM");
    expect(longFormattedDatetime(new Date("2026-12-25T23:05:00Z"), "UTC")).toBe("25 Dec 2026 11:05 PM");
    expect(longFormattedDatetime(new Date("2026-12-26T00:30:00Z"), "UTC")).toBe("26 Dec 2026 12:30 AM");
  });

  it("refuses a zone name it does not know", () => {
    expect(() => longFormattedDatetime(NOW, "Nowhere")).toThrow(/not ported/u);
  });
});

describe("Purchase#as_json(creator_app_api: true)", () => {
  it("serializes a paid sale", () => {
    expect(creatorApp(purchase())).toEqual({
      id: "enc11",
      email: "buyer@example.com",
      seller_id: "enc7",
      timestamp: "less than a minute ago",
      daystamp: " 2 Nov 2026  7:00 AM",
      created_at: "2026-11-02T15:00:00Z",
      link_name: "Product",
      product_name: "Product",
      product_has_variants: false,
      price: "$1",
      gumroad_fee: 29,
      is_bundle_purchase: false,
      is_bundle_product_purchase: false,
      alert: "New sale of Product for $1",
      product_thumbnail_url: null,
      formatted_total_price: "$1",
      refunded: false,
      partially_refunded: false,
      chargedback: false,
    });
  });

  it("alerts a free digital sale as a download", () => {
    const json = creatorApp(purchase({ price_cents: 0, displayed_price_cents: 0 }));
    expect(json).toMatchObject({ price: "$0", alert: "New download of Product" });
  });

  it("alerts a free physical sale as a sale", () => {
    const json = creatorApp(purchase({ price_cents: 0, displayed_price_cents: 0 }), link({ flags: PHYSICAL_BIT }));
    expect(json.alert).toBe("New sale of Product for $0");
  });

  it("prefers the purchaser's account email and counts a reversed chargeback as not charged back", () => {
    const base = {
      purchase: purchase({ chargeback_date: NOW, flags: CHARGEBACK_REVERSED_BIT }),
      link: link(),
      seller,
      purchaser: buyer,
      productHasVariants: true,
      productThumbnailUrl: "https://example.com/t.png",
      now: NOW,
    };
    expect(purchaseAsJsonCreatorApp({ ...base, purchase: purchase({ email: "other@example.com" }) })).toMatchObject({
      email: "buyer@example.com",
      product_has_variants: true,
      product_thumbnail_url: "https://example.com/t.png",
    });
    expect(purchaseAsJsonCreatorApp(base).chargedback).toBe(false);
    expect(purchaseAsJsonCreatorApp({ ...base, purchase: purchase({ chargeback_date: NOW }) }).chargedback).toBe(true);
  });

  it("reads the bundle bit and the refund columns", () => {
    expect(
      creatorApp(purchase({ flags: IS_BUNDLE_PURCHASE_BIT, stripe_refunded: true, stripe_partially_refunded: true })),
    ).toMatchObject({
      is_bundle_purchase: true,
      refunded: true,
      partially_refunded: true,
    });
  });

  it("words the age of an older sale", () => {
    const json = purchaseAsJsonCreatorApp({
      purchase: purchase({ created_at: new Date("2026-10-30T15:00:00Z") }),
      link: link(),
      seller,
      purchaser: null,
      productHasVariants: false,
      productThumbnailUrl: null,
      now: NOW,
    });
    expect(json.timestamp).toBe("3 days ago");
  });
});

describe("Link#as_json(mobile: true)", () => {
  it("serializes a product without previews in the key order Rails renders", () => {
    const json = linkAsJsonMobile(mobileLinkInput());
    expect(Object.keys(json)).toEqual([
      "name",
      "unique_permalink",
      "description",
      "created_at",
      "updated_at",
      "content_updated_at",
      "creator_name",
      "creator_username",
      "creator_profile_picture_url",
      "creator_profile_url",
      "preview_url",
      "thumbnail_url",
      "preview_oembed_url",
      "preview_height",
      "preview_width",
      "has_rich_content",
    ]);
    expect(json).toMatchObject({
      updated_at: "2026-01-02T00:00:00Z",
      content_updated_at: "2026-01-01T00:00:00Z",
      creator_name: "Seller",
      preview_url: "",
      thumbnail_url: null,
      preview_oembed_url: "",
      preview_height: 0,
      preview_width: 0,
      has_rich_content: true,
    });
  });

  it("falls back to the username, then an empty string, for the creator name", () => {
    expect(linkAsJsonMobile(mobileLinkInput({ creator: { ...seller, name: " " } })).creator_name).toBe("seller");
    expect(linkAsJsonMobile(mobileLinkInput({ creator: { ...seller, name: null, username: null } }))).toMatchObject({
      creator_name: "",
      creator_username: "",
    });
  });

  it("prints the preview fields of the main cover", () => {
    const json = linkAsJsonMobile(
      mobileLinkInput({
        preview: {
          previewUrl: "https://example.com/t.png",
          previewOembedUrl: "https://www.youtube.com/embed/x",
          previewHeight: 300,
          previewWidth: 500,
        },
      }),
    );

    expect(json).toMatchObject({
      preview_url: "https://example.com/t.png",
      preview_oembed_url: "https://www.youtube.com/embed/x",
      preview_height: 300,
      preview_width: 500,
    });
  });
});

describe("Purchase#json_data_for_mobile", () => {
  const mobile = (overrides = {}, p: Purchase = purchase({ purchaser_id: 8n })) =>
    purchaseJsonDataForMobile({
      purchase: p,
      link: mobileLinkInput(),
      seller,
      purchaser: buyer,
      productRating: null,
      amountRefundedCents: 0,
      productUpdatesData: null,
      ...overrides,
    });

  it("appends the purchase fields after the product fields", () => {
    expect(mobile()).toMatchObject({
      name: "Product",
      purchase_id: "enc11",
      purchased_at: "2026-11-02T15:00:00Z",
      user_id: "buy8",
      is_archived: false,
      custom_delivery_url: null,
      purchase_email: "buyer@example.com",
      quantity: 1,
      order_id: 1011,
      full_name: "Jane Doe",
      currency_symbol: "$",
      amount_refundable_in_currency: "1",
      refund_fee_notice_shown: false,
      product_rating: null,
      refunded: false,
      partially_refunded: false,
      chargedback: false,
    });
  });

  it("omits user_id without a purchaser and falls back to the purchaser's name and email", () => {
    const json = mobile({ purchaser: null }, purchase({ email: null, full_name: "  " }));
    expect(json).not.toHaveProperty("user_id");
    expect(json).toMatchObject({ purchase_email: null, full_name: null });
    expect(mobile({}, purchase({ email: "", full_name: null, flags: IS_ARCHIVED_BIT }))).toMatchObject({
      purchase_email: "buyer@example.com",
      full_name: "Buyer",
      is_archived: true,
    });
  });

  it("refunds nothing for a processor that is no longer supported and subtracts what was refunded otherwise", () => {
    expect(mobile({}, purchase({ charge_processor_id: "legacy" })).amount_refundable_in_currency).toBe("0");
    expect(mobile({ amountRefundedCents: 40 }).amount_refundable_in_currency).toBe("0.60");
  });

  it("reads the seller's refund fee notice flag", () => {
    expect(mobile({ seller: { ...seller, flags: 1n << 6n } }).refund_fee_notice_shown).toBe(true);
  });

  it("leaves product_updates_data out unless it is given, and puts it after purchased_at", () => {
    expect(mobile()).not.toHaveProperty("product_updates_data");
    const keys = Object.keys(mobile({ productUpdatesData: [] }));
    expect(mobile({ productUpdatesData: [] }).product_updates_data).toEqual([]);
    expect(keys.indexOf("product_updates_data")).toBe(keys.indexOf("purchased_at") + 1);
    expect(keys.indexOf("user_id")).toBe(keys.indexOf("product_updates_data") + 1);
  });

  it("takes the purchase fields of a preorder from its source purchase, ends them with preorder_data and leaves out custom_delivery_url", () => {
    const source = purchase({ id: 99n, flags: IS_ARCHIVED_BIT });
    const json = mobile({
      productUpdatesData: [],
      preorder: {
        source,
        sourcePurchaser: buyer,
        preorderData: { external_id: "pre1", release_at: "2030-01-15T12:00:00Z" },
      },
    });
    expect(json).toMatchObject({ purchase_id: "enc99", is_archived: true, order_id: 1011 });
    expect(json).not.toHaveProperty("custom_delivery_url");
    const keys = Object.keys(json);
    expect(keys.indexOf("user_id")).toBe(keys.indexOf("purchased_at") + 1);
    expect(keys.indexOf("preorder_data")).toBe(keys.indexOf("is_archived") + 1);
  });

  it("refuses gifts and a currency with no stored rate", () => {
    expect(() => mobile({}, purchase({ flags: GIFT_SENDER_BIT }))).toThrow(/not ported/u);
    expect(() => mobile({}, purchase({ displayed_price_currency_type: "eur", rate_converted_to_usd: null }))).toThrow(
      /not ported/u,
    );
  });

  it("writes the symbol and the refundable amount in the purchase currency at the stored rate", () => {
    const euro = purchase({ displayed_price_currency_type: "eur", rate_converted_to_usd: "0.81", price_cents: 1250 });
    expect(mobile({ amountRefundedCents: 250 }, euro)).toMatchObject({
      currency_symbol: "€",
      amount_refundable_in_currency: "8.10",
    });
    const yen = purchase({ displayed_price_currency_type: "jpy", rate_converted_to_usd: "150.0", price_cents: 1000 });
    expect(mobile({}, yen)).toMatchObject({ currency_symbol: "¥", amount_refundable_in_currency: "1,500" });
  });

  it("puts subscription_data before purchase_email and leaves file_data out for a membership that ended", () => {
    const subscriptionData = { id: "sub1", subscribed_at: "2026-11-02T15:00:00Z", ended_at: null, ended_reason: null };
    const json = mobile({
      subscriptionData,
      urlRedirect: { urlRedirectExternalId: "ur1", urlRedirectToken: "tok", fileData: null },
    });
    expect(json).toMatchObject({ subscription_data: subscriptionData, url_redirect_token: "tok" });
    expect(json).not.toHaveProperty("file_data");
    const keys = Object.keys(json);
    expect(keys.indexOf("purchase_email")).toBe(keys.indexOf("subscription_data") + 1);
  });

  it("prints the SKU, shipment, offer code and affiliate of a sale after the variants and before the price", () => {
    const json = mobile({
      saleDetails: {
        variants: { Size: { is_sku: true } },
        sku: { id: "LRG-1", externalId: "enc5" },
        shipment: { shipped: true, tracking_url: null, shipping_address: { city: "Town" } },
        offerCode: { code: "half", displayed_amount_off: "50%" },
        affiliate: { email: "a@example.com", amount: "$1.50" },
      },
    });
    const keys = Object.keys(json);
    expect(keys.slice(keys.indexOf("variants"))).toEqual([
      "variants",
      "sku_id",
      "sku_external_id",
      "shipped",
      "tracking_url",
      "shipping_address",
      "offer_code",
      "affiliate",
      "formatted_total_price",
      "purchase_daystamp",
    ]);
    expect(json).toMatchObject({ sku_id: "LRG-1", sku_external_id: "enc5", shipped: true, tracking_url: null });
  });

  it("leaves out the keys of a SKU, shipment and affiliate the sale does not have", () => {
    const json = mobile({
      saleDetails: { variants: null, sku: null, shipment: null, offerCode: null, affiliate: null },
    });
    for (const key of ["variants", "sku_id", "shipped", "tracking_url", "shipping_address", "offer_code", "affiliate"])
      expect(json).not.toHaveProperty(key);
  });
});
