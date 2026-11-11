// Pure ports of the JSON the Api::Mobile purchases and sales endpoints build. Each builder takes rows already loaded (see
// mobile-serializer-reads.ts) and throws NotPortedError for every shape it does not reproduce, so the caller hands the request
// to Rails whole. The simple shape is: USD, no subscription, no price record, no preorder, no url_redirect, no gift.
import type { Link, Purchase, User } from "@prisma/client";

import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { moneyFormatterFormat, symbolFor, formatJustPriceInCents } from "../models/concerns/money-formatter.ts";
import { timeAgoInWords } from "../models/concerns/time-ago-in-words.ts";
import { LinkFlags } from "../models/link.ts";
import { UserFlags } from "../models/user.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { longFormattedDatetime } from "./mobile-time.ts";

// ChargeProcessor.charge_processor_ids
const CHARGE_PROCESSOR_IDS = ["stripe", "braintree", "paypal"];
const MOBILE_PREVIEW_HEIGHT_FLOOR = 0;

// ActiveSupport::TimeWithZone#as_json under config/initializers/json_time_precision.rb (time_precision = 0): ISO 8601, UTC, no fraction.
export const jsonTime = (time: Date | null | undefined): string | null =>
  time == null ? null : time.toISOString().replace(/\.\d{3}Z$/u, "Z");

// String#strip: leading and trailing NUL and ASCII whitespace
const rubyStrip = (value: string | null): string | null =>
  value == null ? null : value.replace(/^[\0\t-\r ]+|[\0\t-\r ]+$/gu, "");

const presence = (value: string | null | undefined): string | null =>
  value == null || value.trim() === "" ? null : value;

export type MobileLinkInput = {
  link: Link;
  creator: User;
  creatorAvatarUrl: string;
  creatorProfileUrl: string;
  // Link#thumbnail_or_cover_url
  thumbnailOrCoverUrl: string | null;
  // Link#display_asset_previews, which would feed preview_url, the oembed fields and the preview size.
  hasAlivePreviews: boolean;
};

// Port of app/models/concerns/product/as_json.rb (Product::AsJson#as_json_for_mobile_api)
export function linkAsJsonMobile(input: MobileLinkInput): Record<string, unknown> {
  const { link, creator } = input;
  if (input.hasAlivePreviews) throw new NotPortedError("Link#as_json(mobile: true) for a product with asset previews");
  return {
    // serializable_hash(only:) keeps columns in table order
    name: link.name,
    unique_permalink: link.unique_permalink,
    description: link.description,
    created_at: jsonTime(link.created_at),
    updated_at: jsonTime(link.updated_at),
    content_updated_at: jsonTime(link.content_updated_at ?? link.created_at),
    creator_name: presence(creator.name) ?? creator.username ?? "",
    creator_username: creator.username ?? "",
    creator_profile_picture_url: input.creatorAvatarUrl,
    creator_profile_url: input.creatorProfileUrl,
    // preview_oembed_thumbnail_url || preview_url || "" with no main preview
    preview_url: "",
    thumbnail_url: input.thumbnailOrCoverUrl,
    // mobile_oembed_url, preview_height_for_mobile and preview_width_for_mobile without a preview
    preview_oembed_url: "",
    preview_height: MOBILE_PREVIEW_HEIGHT_FLOOR,
    preview_width: 0,
    has_rich_content: true,
  };
}

const isFlag = (purchase: Purchase, name: Parameters<typeof PurchaseFlags.isSet>[1]) =>
  PurchaseFlags.isSet(purchase.flags, name);

// Purchase#symbol_for(displayed_price_currency_type) and the prices below are only proven for USD with no recurrence label.
function assertSimpleMoneyShape(purchase: Purchase): void {
  if (purchase.displayed_price_currency_type !== "usd")
    throw new NotPortedError("a purchase priced in a currency other than USD");
  if (purchase.price_id != null || purchase.subscription_id != null)
    throw new NotPortedError(
      "a purchase with a recurrence price (Purchase#format_price_in_cents with price_for_recurrence)",
    );
  if (purchase.displayed_price_cents == null || purchase.price_cents == null)
    throw new NotPortedError("a purchase without a price");
}

// Purchase#formatted_display_price
export function formattedDisplayPrice(purchase: Purchase): string {
  assertSimpleMoneyShape(purchase);
  return formatJustPriceInCents(purchase.displayed_price_cents, "usd");
}

// Purchase#formatted_total_price (usd_cents_to_currency is the identity for USD)
export function formattedTotalPrice(purchase: Purchase): string {
  assertSimpleMoneyShape(purchase);
  return formatJustPriceInCents(purchase.price_cents, "usd");
}

// Purchase#chargedback_not_reversed?
const chargedbackNotReversed = (purchase: Purchase) =>
  purchase.chargeback_date != null && !isFlag(purchase, "chargeback_reversed");

export type CreatorAppPurchaseInput = {
  purchase: Purchase;
  link: Link;
  seller: User;
  purchaser: User | null;
  // link.variant_categories_alive.exists?
  productHasVariants: boolean;
  // link.thumbnail&.alive&.url.presence
  productThumbnailUrl: string | null;
  now: Date;
};

// Port of app/models/purchase.rb (Purchase#as_json with creator_app_api: true, version 1)
export function purchaseAsJsonCreatorApp(input: CreatorAppPurchaseInput): Record<string, unknown> {
  const { purchase, link, seller, purchaser } = input;
  if (purchase.created_at == null) throw new NotPortedError("a purchase without created_at");
  if (seller.timezone == null) throw new NotPortedError("a seller without a time zone");
  const displayPrice = formattedDisplayPrice(purchase);
  const totalPrice = formattedTotalPrice(purchase);
  const physical = LinkFlags.isSet(link.flags, "is_physical");
  return {
    id: encrypt(purchase.id),
    // purchaser_email_or_email
    email: presence(purchaser?.email) ?? purchase.email,
    seller_id: encrypt(seller.id),
    timestamp: `${timeAgoInWords(purchase.created_at, input.now)} ago`,
    daystamp: longFormattedDatetime(purchase.created_at, seller.timezone),
    created_at: jsonTime(purchase.created_at),
    link_name: link.name,
    product_name: link.name,
    product_has_variants: input.productHasVariants,
    price: displayPrice,
    gumroad_fee: purchase.fee_cents,
    is_bundle_purchase: isFlag(purchase, "is_bundle_purchase"),
    is_bundle_product_purchase: isFlag(purchase, "is_bundle_product_purchase"),
    // additional_fields_for_creator_app_api
    alert:
      purchase.price_cents === 0 && !physical
        ? `New download of ${link.name}`
        : `New sale of ${link.name} for ${totalPrice}`,
    product_thumbnail_url: input.productThumbnailUrl,
    formatted_total_price: totalPrice,
    refunded: purchase.stripe_refunded === true,
    partially_refunded: purchase.stripe_partially_refunded,
    chargedback: chargedbackNotReversed(purchase),
  };
}

export type MobilePurchaseInput = {
  purchase: Purchase;
  link: MobileLinkInput;
  seller: User;
  purchaser: User | null;
  // Purchase#original_product_review.try(:rating)
  productRating: number | null;
  // Purchase#amount_refunded_cents (sum of effective refunds)
  amountRefundedCents: number;
  // Purchase#update_json_data_for_mobile (see models/purchase-product-updates.ts); null leaves the key out, as include_product_updates: false does
  productUpdatesData: Record<string, unknown>[] | null;
};

// Port of app/models/purchase.rb (Purchase#json_data_for_mobile) for a purchase with no url_redirect, preorder or subscription,
// without include_sale_details.
export function purchaseJsonDataForMobile(input: MobilePurchaseInput): Record<string, unknown> {
  const { purchase, seller, purchaser } = input;
  assertSimpleMoneyShape(purchase);
  if (isFlag(purchase, "is_gift_sender_purchase") || isFlag(purchase, "is_gift_receiver_purchase"))
    throw new NotPortedError("a gift purchase");
  if (purchase.created_at == null) throw new NotPortedError("a purchase without created_at");

  const json: Record<string, unknown> = linkAsJsonMobile(input.link);
  json.purchase_id = encrypt(purchase.id);
  json.purchased_at = jsonTime(purchase.created_at);
  if (input.productUpdatesData !== null) json.product_updates_data = input.productUpdatesData;
  if (purchaser) json.user_id = purchaser.external_id;
  json.is_archived = isFlag(purchase, "is_archived");
  json.custom_delivery_url = null;
  json.purchase_email = presence(purchase.email) ?? presence(purchaser?.email);
  json.quantity = purchase.quantity;
  json.order_id = encryptNumeric(Number(purchase.id));
  json.full_name = presence(rubyStrip(purchase.full_name)) ?? purchaser?.name ?? null;
  json.currency_symbol = symbolFor("usd");
  const priceCents = purchase.price_cents ?? 0;
  // amount_refundable_cents: 0 for a processor that is no longer supported
  const refundableCents = CHARGE_PROCESSOR_IDS.includes(purchase.charge_processor_id ?? "")
    ? priceCents - input.amountRefundedCents
    : 0;
  json.amount_refundable_in_currency = moneyFormatterFormat(refundableCents, "usd", {
    noCentsIfWhole: true,
    symbol: false,
  });
  json.refund_fee_notice_shown = UserFlags.isSet(seller.flags, "refund_fee_notice_shown");
  json.product_rating = input.productRating;
  json.refunded = purchase.stripe_refunded === true;
  json.partially_refunded = purchase.stripe_partially_refunded;
  json.chargedback = chargedbackNotReversed(purchase);
  return json;
}
