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
  hasAlivePreviews: false,
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

  it.each([
    ["a currency other than USD", { displayed_price_currency_type: "eur" }],
    ["a recurrence price", { price_id: 5n }],
    ["a subscription", { subscription_id: 5n }],
  ])("refuses %s", (_name, overrides) => {
    expect(() => formattedDisplayPrice(purchase(overrides as Partial<Purchase>))).toThrow(/not ported/u);
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

  it("refuses a product with asset previews", () => {
    expect(() => linkAsJsonMobile(mobileLinkInput({ hasAlivePreviews: true }))).toThrow(/not ported/u);
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
      includeProductUpdates: false,
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

  it("refuses product updates, gifts and subscriptions", () => {
    expect(() => mobile({ includeProductUpdates: true })).toThrow(/not ported/u);
    expect(() => mobile({}, purchase({ flags: GIFT_SENDER_BIT }))).toThrow(/not ported/u);
    expect(() => mobile({}, purchase({ subscription_id: 4n }))).toThrow(/not ported/u);
  });
});
