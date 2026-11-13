// Pure ports of the JSON the Api::Mobile purchases and sales endpoints build. Each builder takes rows already loaded (see
// mobile-serializer-reads.ts) and throws NotPortedError for every shape it does not reproduce, so the caller hands the request
// to Rails whole. The simple shape is: a USD or stored-rate currency, no subscription, no price record, no preorder, no url_redirect, no gift.
import type { Link, Purchase, User } from "@prisma/client";

import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { rubyStringToF, usdCentsToCurrencyAtRate } from "../models/concerns/currency-helper.ts";
import {
  formatJustPriceInCents,
  knownCurrency,
  moneyFormatterFormat,
  symbolFor,
} from "../models/concerns/money-formatter.ts";
import { timeAgoInWords } from "../models/concerns/time-ago-in-words.ts";
import { LinkFlags } from "../models/link.ts";
import { UserFlags } from "../models/user.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { PurchaseFlags } from "../search/flags.ts";

import type { MobilePreview } from "./mobile-preview.ts";
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
  // The preview fields of Link#display_asset_previews (mobile-preview.ts); null for a product without a cover.
  preview: MobilePreview | null;
};

// Port of app/models/concerns/product/as_json.rb (Product::AsJson#as_json_for_mobile_api)
export function linkAsJsonMobile(input: MobileLinkInput): Record<string, unknown> {
  const { link, creator } = input;
  const { preview } = input;
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
    preview_url: preview?.previewUrl ?? "",
    thumbnail_url: input.thumbnailOrCoverUrl,
    // mobile_oembed_url, preview_height_for_mobile and preview_width_for_mobile without a preview
    preview_oembed_url: preview?.previewOembedUrl ?? "",
    preview_height: preview?.previewHeight ?? MOBILE_PREVIEW_HEIGHT_FLOOR,
    preview_width: preview?.previewWidth ?? 0,
    has_rich_content: true,
  };
}

const isFlag = (purchase: Purchase, name: Parameters<typeof PurchaseFlags.isSet>[1]) =>
  PurchaseFlags.isSet(purchase.flags, name);

// The currency a purchase prices in, with what the helpers below need to convert USD cents into it. Anything that would make
// Rails look a rate up, or soft-fail an unknown code (an ErrorNotifier call), is Rails'.
function purchaseCurrency(purchase: Purchase): { code: string; rate: number | null } {
  const code = purchase.displayed_price_currency_type;
  if (code === null) throw new NotPortedError("a purchase without a currency");
  if (code === "usd") return { code, rate: null };
  if (!knownCurrency(code)) throw new NotPortedError(`a purchase priced in the unknown currency ${code}`);
  if (purchase.rate_converted_to_usd == null || purchase.rate_converted_to_usd.trim() === "")
    throw new NotPortedError("CurrencyHelper#get_rate for a purchase with no stored rate");
  return { code, rate: rubyStringToF(purchase.rate_converted_to_usd) };
}

// usd_cents_to_currency(displayed_price_currency_type, cents, rate_converted_to_usd)
function usdCentsToPurchaseCurrency(purchase: Purchase, cents: number): number {
  const { code, rate } = purchaseCurrency(purchase);
  return rate === null ? cents : usdCentsToCurrencyAtRate(code, cents, rate);
}

// The prices below are only proven without a recurrence label.
function assertSimpleMoneyShape(purchase: Purchase): void {
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
  return formatJustPriceInCents(purchase.displayed_price_cents, purchaseCurrency(purchase).code);
}

// Purchase#formatted_total_price
export function formattedTotalPrice(purchase: Purchase): string {
  assertSimpleMoneyShape(purchase);
  return formatJustPriceInCents(
    usdCentsToPurchaseCurrency(purchase, purchase.price_cents!),
    purchaseCurrency(purchase).code,
  );
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
  // UrlRedirect#product_json_data's own keys; present when the purchase has a url redirect
  // fileData is null for a membership that is no longer alive: UrlRedirect#product_json_data leaves the key out.
  urlRedirect?: { urlRedirectExternalId: string; urlRedirectToken: string; fileData: unknown[] | null };
  // Purchase#json_data_for_mobile's subscription_data; present when the purchase belongs to a subscription
  subscriptionData?: { id: string; subscribed_at: string | null; ended_at: string | null; ended_reason: string | null };
  // Preorder#mobile_json_data: the purchase that supplies purchase_id, purchased_at, user_id, is_archived and the product updates is the
  // preorder's authorization or latest charge, not necessarily this one. That branch has no custom_delivery_url, and an uncharged
  // preorder adds preorder_data.
  preorder?: {
    source: Purchase;
    sourcePurchaser: User | null;
    preorderData: { external_id: string; release_at: string | null } | null;
  };
  // include_sale_details: true. The price and the daystamp come from the purchase; the rest from rows the caller read.
  saleDetails?: SaleDetails;
};

export type SaleDetails = {
  // variant_details_hash of a purchase with one non-SKU variant; null leaves the key out
  variants: Record<string, unknown> | null;
  // { code, displayed_amount_off } of a purchase with an offer code; null leaves the key out
  offerCode: { code: string | null; displayed_amount_off: string } | null;
  // sku_id (the custom SKU or the external id) and sku_external_id of a purchase whose variant is a SKU
  sku?: { id: string; externalId: string } | null;
  // shipped, tracking_url and shipping_address of a purchase with a shipment
  shipment?: { shipped: boolean; tracking_url: string | null; shipping_address: Record<string, string | null> } | null;
  // { email, amount } of the purchase's affiliate
  affiliate?: { email: string | null; amount: string } | null;
};

// Port of app/models/purchase.rb (Purchase#json_data_for_mobile) for a purchase with no url_redirect, preorder or subscription,
// without include_sale_details.
export function purchaseJsonDataForMobile(input: MobilePurchaseInput): Record<string, unknown> {
  const { purchase, seller, purchaser } = input;
  // The fields below print no recurrence label, so only the currency and a price are needed.
  if (purchase.price_cents == null) throw new NotPortedError("a purchase without a price");
  if (isFlag(purchase, "is_gift_sender_purchase") || isFlag(purchase, "is_gift_receiver_purchase"))
    throw new NotPortedError("a gift purchase");
  if (purchase.created_at == null) throw new NotPortedError("a purchase without created_at");

  const json: Record<string, unknown> = linkAsJsonMobile(input.link);
  const source = input.preorder?.source ?? purchase;
  const sourcePurchaser = input.preorder ? input.preorder.sourcePurchaser : purchaser;
  if (source.created_at == null) throw new NotPortedError("a purchase without created_at");
  if (input.urlRedirect) {
    json.url_redirect_external_id = input.urlRedirect.urlRedirectExternalId;
    json.url_redirect_token = input.urlRedirect.urlRedirectToken;
    if (input.urlRedirect.fileData !== null) json.file_data = input.urlRedirect.fileData;
  }
  json.purchase_id = encrypt(source.id);
  json.purchased_at = jsonTime(source.created_at);
  // UrlRedirect#product_json_data and Preorder#mobile_json_data_for_purchase set user_id before product_updates_data; the plain
  // branch the other way round.
  if (input.urlRedirect || input.preorder) {
    if (sourcePurchaser) json.user_id = sourcePurchaser.external_id;
    if (input.productUpdatesData !== null) json.product_updates_data = input.productUpdatesData;
  } else {
    if (input.productUpdatesData !== null) json.product_updates_data = input.productUpdatesData;
    if (purchaser) json.user_id = purchaser.external_id;
  }
  json.is_archived = isFlag(source, "is_archived");
  if (input.preorder) {
    if (input.preorder.preorderData) json.preorder_data = input.preorder.preorderData;
  } else {
    json.custom_delivery_url = null;
  }
  if (input.subscriptionData) json.subscription_data = input.subscriptionData;
  json.purchase_email = presence(purchase.email) ?? presence(purchaser?.email);
  json.quantity = purchase.quantity;
  json.order_id = encryptNumeric(Number(purchase.id));
  json.full_name = presence(rubyStrip(purchase.full_name)) ?? purchaser?.name ?? null;
  json.currency_symbol = symbolFor(purchaseCurrency(purchase).code);
  const priceCents = purchase.price_cents ?? 0;
  // amount_refundable_cents: 0 for a processor that is no longer supported
  const refundableCents = CHARGE_PROCESSOR_IDS.includes(purchase.charge_processor_id ?? "")
    ? priceCents - input.amountRefundedCents
    : 0;
  json.amount_refundable_in_currency = moneyFormatterFormat(
    usdCentsToPurchaseCurrency(purchase, refundableCents),
    purchaseCurrency(purchase).code,
    { noCentsIfWhole: true, symbol: false },
  );
  json.refund_fee_notice_shown = UserFlags.isSet(seller.flags, "refund_fee_notice_shown");
  json.product_rating = input.productRating;
  json.refunded = purchase.stripe_refunded === true;
  json.partially_refunded = purchase.stripe_partially_refunded;
  json.chargedback = chargedbackNotReversed(purchase);
  if (input.saleDetails) {
    if (seller.timezone == null) throw new NotPortedError("a seller without a time zone");
    if (input.saleDetails.variants !== null) json.variants = input.saleDetails.variants;
    if (input.saleDetails.sku) {
      json.sku_id = input.saleDetails.sku.id;
      json.sku_external_id = input.saleDetails.sku.externalId;
    }
    if (input.saleDetails.shipment) {
      json.shipped = input.saleDetails.shipment.shipped;
      json.tracking_url = input.saleDetails.shipment.tracking_url;
      json.shipping_address = input.saleDetails.shipment.shipping_address;
    }
    if (input.saleDetails.offerCode !== null) json.offer_code = input.saleDetails.offerCode;
    if (input.saleDetails.affiliate) json.affiliate = input.saleDetails.affiliate;
    json.formatted_total_price = formattedTotalPrice(purchase);
    json.purchase_daystamp = longFormattedDatetime(purchase.created_at, seller.timezone);
  }
  return json;
}
