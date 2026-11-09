// Port of app/controllers/api/mobile/subscriptions_controller.rb#subscription_attributes.
//
// Served here: the 404 for a subscription that is not `Subscription.active` and the payload of one whose product, creator and original
// purchase fit the ported serializers (USD, no asset previews, no uploaded avatar or thumbnail) and whose seller has no posts, so
// `updates_data` is []. Everything else goes to Rails whole. #cancel is not registered: it ends the subscription, sends mail and
// enqueues jobs, so Rails keeps it.
import { Prisma, type Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { formatJustPriceInCents } from "../models/concerns/money-formatter.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { ACTIVE_SUBSCRIPTION } from "../models/subscription-json.ts";
import { RECURRENCE_LABELS } from "../page-props/seller-products/listing.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import { profileUrl } from "../page-props/buyer/users.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { jsonTime, linkAsJsonMobile } from "../presenters/mobile-serializers.ts";
import { thumbnailUrlsByProduct } from "../presenters/mobile-serializer-reads.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { fetchError, registerMobile, renderJson, type MobileInput } from "./mobile-api.ts";

const NOT_FOUND_MESSAGE = "Could not find subscription";
const SINGLE_CHARGE = 1;

type SubscriptionRow = {
  id: bigint;
  link_id: bigint | null;
  created_at: Date;
  charge_occurrence_count: number | null;
  last_payment_option_id: bigint | null;
};

// `Subscription.active.find_by_external_id(params[:id])`
async function findActive(externalId: unknown, now: Date): Promise<SubscriptionRow | null> {
  const id = typeof externalId === "string" ? decrypt(externalId) : null;
  if (id === null) return null;
  const [row] = await selectRows<SubscriptionRow>(
    Prisma.sql`SELECT ${column("subscriptions", "id")}, ${column("subscriptions", "link_id")}, ${column("subscriptions", "created_at")}, ${column("subscriptions", "charge_occurrence_count")}, ${column("subscriptions", "last_payment_option_id")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${BigInt(id)} AND ${ACTIVE_SUBSCRIPTION(now)} LIMIT 1`,
  );
  return row ?? null;
}

// Subscription#original_purchase: `is_original_subscription_purchase.not_is_archived_original_subscription_purchase`
async function originalPurchase(subscriptionId: bigint): Promise<Purchase | null> {
  const [row] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscriptionId} AND ${PurchaseFlags.condition("is_original_subscription_purchase", true)} AND ${PurchaseFlags.condition("is_archived_original_subscription_purchase", false)} ORDER BY ${column("purchases", "id")} ASC LIMIT 1`,
  );
  return row === undefined ? null : db.purchase.findUnique({ where: { id: BigInt(row.id) } });
}

// Purchase#price_for_recurrence: the purchase's own price, else its subscription's last payment option's. A price row that is gone is nil.
async function recurrenceOf(purchase: Purchase, subscription: SubscriptionRow): Promise<string | null> {
  let priceId: bigint | number | null = purchase.price_id;
  if (priceId === null) {
    if (subscription.last_payment_option_id === null)
      throw new NotPortedError("Subscription#fetch_last_payment_option");
    const [option] = await selectRows<{ price_id: bigint | null }>(
      Prisma.sql`SELECT ${column("payment_options", "price_id")} FROM ${table("payment_options")} WHERE ${column("payment_options", "id")} = ${subscription.last_payment_option_id} LIMIT 1`,
    );
    priceId = option?.price_id ?? null;
  }
  if (priceId === null) return null;
  const [price] = await selectRows<{ recurrence: string | null }>(
    Prisma.sql`SELECT ${column("prices", "recurrence")} FROM ${table("prices")} WHERE ${column("prices", "id")} = ${BigInt(priceId)} LIMIT 1`,
  );
  return price?.recurrence ?? null;
}

// Purchase#formatted_display_price: format_price_in_cents with the recurrence of price_for_recurrence
function formattedDisplayPrice(
  purchase: Purchase,
  recurrence: string | null,
  chargeOccurrenceCount: number | null,
): string {
  if ((purchase.displayed_price_currency_type ?? "usd") !== "usd" || purchase.displayed_price_cents === null)
    throw new NotPortedError("a purchase priced in a currency other than USD");
  const text = formatJustPriceInCents(purchase.displayed_price_cents, "usd");
  const count = chargeOccurrenceCount === SINGLE_CHARGE ? SINGLE_CHARGE : null;
  if (recurrence === null) return count === null ? text : `${text} x ${count}`;
  if (count === SINGLE_CHARGE) return `${text} once`;
  const label = RECURRENCE_LABELS[recurrence];
  if (label === undefined) throw new NotPortedError("an unknown recurrence");
  return `${text} ${label}`;
}

// updates_mobile_json_data maps original_purchase.product_installments (workflows, filters, email infos), so any post of the seller is Rails'.
async function sellerHasPosts(sellerId: bigint, productId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${sellerId} OR ${column("installments", "link_id")} = ${productId} LIMIT 1`,
  );
  return rows.length > 0;
}

// Subscription#subscription_mobile_json_data
async function subscriptionAttributes(input: MobileInput) {
  const now = new Date();
  const subscription = await findActive(input.params.id, now);
  if (subscription === null) return fetchError(NOT_FOUND_MESSAGE);
  if (subscription.link_id === null) throw new NotPortedError("a subscription without a product");
  const link = await db.link.findUnique({ where: { id: subscription.link_id } });
  const creator = link?.user_id == null ? null : await db.user.findUnique({ where: { id: link.user_id } });
  if (!link || !creator) throw new NotPortedError("a subscription whose product or creator row is missing");
  const purchase = await originalPurchase(subscription.id);
  if (purchase === null) throw new NotPortedError("a subscription without an original purchase");
  if (await sellerHasPosts(creator.id, link.id))
    throw new NotPortedError("Subscription#updates_mobile_json_data for a seller with posts");

  const previews = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${link.id} AND ${column("asset_previews", "deleted_at")} IS NULL LIMIT 1`,
  );
  const thumbnails = await thumbnailUrlsByProduct([link.id]);
  const purchaser =
    purchase.purchaser_id === null ? null : await db.user.findUnique({ where: { id: purchase.purchaser_id } });
  if (creator.username === null || creator.username.trim() === "")
    throw new NotPortedError("User#profile_url for a creator without a username");

  const json: Record<string, unknown> = linkAsJsonMobile({
    link,
    creator,
    creatorAvatarUrl: await avatarUrl(creator),
    creatorProfileUrl: profileUrl(creator),
    thumbnailOrCoverUrl: thumbnails.get(link.id) ?? null,
    hasAlivePreviews: previews.length > 0,
  });
  json.subscription_data = {
    subscribed_at: jsonTime(subscription.created_at),
    external_id: encrypt(subscription.id),
    recurring_amount: formattedDisplayPrice(
      purchase,
      await recurrenceOf(purchase, subscription),
      subscription.charge_occurrence_count,
    ),
  };
  json.purchase_id = encrypt(purchase.id);
  json.purchased_at = jsonTime(purchase.created_at);
  if (purchaser) json.user_id = purchaser.external_id;
  json.can_contact = purchase.can_contact;
  json.updates_data = [];
  return renderJson({ success: true, subscription: json });
}

registerMobile({
  method: "GET",
  pattern: "/mobile/subscriptions/subscription_attributes/:id",
  scopes: null,
  run: subscriptionAttributes,
});
