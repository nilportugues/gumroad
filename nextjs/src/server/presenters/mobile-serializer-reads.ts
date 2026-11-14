// The reads behind mobile-serializers.ts: the rows a page of purchases serializes from, loaded in a bounded number of queries.
import { Prisma, type Link, type User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { RECURRENCE_LONG_INDICATOR } from "../models/purchase-json.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { hasAttachment } from "../page-props/buyer/products.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { purchaseAsJsonCreatorApp } from "./mobile-serializers.ts";

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// link.thumbnail&.alive&.url.presence: has_one :thumbnail is the first row whatever its state; only an alive one has a url.
export async function thumbnailUrlsByProduct(productIds: bigint[]): Promise<Map<bigint, string | null>> {
  const urls = new Map<bigint, string | null>();
  if (productIds.length === 0) return urls;
  const rows = await selectRows<{
    id: bigint;
    product_id: bigint;
    unsplash_url: string | null;
    deleted_at: Date | null;
  }>(
    Prisma.sql`SELECT ${column("thumbnails", "id")}, ${column("thumbnails", "product_id")}, ${column("thumbnails", "unsplash_url")}, ${column("thumbnails", "deleted_at")} FROM ${table("thumbnails")} WHERE ${column("thumbnails", "product_id")} IN (${Prisma.join(productIds)}) ORDER BY ${column("thumbnails", "id")} ASC`,
  );
  for (const row of rows) {
    const productId = BigInt(row.product_id);
    if (urls.has(productId)) continue;
    if (row.deleted_at != null) urls.set(productId, null);
    else if (present(row.unsplash_url)) urls.set(productId, row.unsplash_url);
    else if (await hasAttachment("Thumbnail", BigInt(row.id), "file"))
      throw new NotPortedError("Thumbnail#url for an uploaded file");
    else urls.set(productId, null);
  }
  return urls;
}

// link.variant_categories_alive.exists?
async function productsWithVariants(productIds: bigint[]): Promise<Set<bigint>> {
  if (productIds.length === 0) return new Set();
  const rows = await selectRows<{ link_id: bigint }>(
    Prisma.sql`SELECT DISTINCT ${column("variant_categories", "link_id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} IN (${Prisma.join(productIds)}) AND ${column("variant_categories", "deleted_at")} IS NULL`,
  );
  return new Set(rows.map((row) => BigInt(row.link_id)));
}

// Recurrence labels proven against a recording: the label is "a month" for a monthly price.
const PROVEN_RECURRENCE_LABELS: Record<string, string> = { monthly: RECURRENCE_LONG_INDICATOR.monthly! };

// The label `format_price_in_cents` appends for a subscription purchase: `price_for_recurrence` is the price of the subscription's last
// payment option. A subscription that charges a fixed number of times ("once", " x N") or a price that is not monthly is Rails'.
export async function subscriptionRecurrenceLabels(
  purchases: { subscription_id: bigint | null }[],
): Promise<Map<bigint, string>> {
  const labels = new Map<bigint, string>();
  const subscriptionIds = [
    ...new Set(purchases.map((purchase) => purchase.subscription_id).filter((id): id is bigint => id != null)),
  ];
  if (subscriptionIds.length === 0) return labels;
  const rows = await selectRows<{
    id: bigint;
    charge_occurrence_count: number | null;
    last_payment_option_id: bigint | null;
    recurrence: string | null;
  }>(
    Prisma.sql`SELECT ${column("subscriptions", "id")}, ${column("subscriptions", "charge_occurrence_count")}, ${column("subscriptions", "last_payment_option_id")}, ${column("prices", "recurrence")} FROM ${table("subscriptions")} LEFT JOIN ${table("payment_options")} ON ${column("payment_options", "id")} = ${column("subscriptions", "last_payment_option_id")} LEFT JOIN ${table("prices")} ON ${column("prices", "id")} = ${column("payment_options", "price_id")} WHERE ${column("subscriptions", "id")} IN (${Prisma.join(subscriptionIds)})`,
  );
  if (rows.length !== subscriptionIds.length) throw new NotPortedError("a purchase whose subscription row is missing");
  for (const row of rows) {
    if (row.charge_occurrence_count !== null)
      throw new NotPortedError("a subscription that charges a fixed number of times");
    const label = row.recurrence === null ? undefined : PROVEN_RECURRENCE_LABELS[row.recurrence];
    if (label === undefined) throw new NotPortedError("a subscription whose price is not monthly");
    labels.set(BigInt(row.id), label);
  }
  return labels;
}

// SalesController#index: `Purchase.where(id: ids).in_order_of(:id, ids).as_json(creator_app_api: true)`. An id with no row is dropped.
export async function creatorAppPurchasesJson(
  ids: bigint[],
  now: Date = new Date(),
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const purchases = await db.purchase.findMany({ where: { id: { in: ids } } });
  const byId = new Map(purchases.map((purchase) => [purchase.id, purchase]));
  const ordered = ids.flatMap((id) => byId.get(id) ?? []);

  const productIds = [...new Set(ordered.map((purchase) => purchase.link_id).filter((id): id is bigint => id != null))];
  const userIds = [
    ...new Set(
      ordered
        .flatMap((purchase) => [purchase.seller_id, purchase.purchaser_id])
        .filter((id): id is bigint => id != null),
    ),
  ];
  const [links, users, thumbnails, withVariants, recurrenceLabels] = await Promise.all([
    db.link.findMany({ where: { id: { in: productIds } } }),
    db.user.findMany({ where: { id: { in: userIds } } }),
    thumbnailUrlsByProduct(productIds),
    productsWithVariants(productIds),
    subscriptionRecurrenceLabels(ordered),
  ]);
  const linkById = new Map<bigint, Link>(links.map((link) => [link.id, link]));
  const userById = new Map<bigint, User>(users.map((user) => [user.id, user]));

  return ordered.map((purchase) => {
    const link = purchase.link_id == null ? undefined : linkById.get(purchase.link_id);
    const seller = purchase.seller_id == null ? undefined : userById.get(purchase.seller_id);
    if (!link || !seller) throw new NotPortedError("a purchase whose product or seller row is missing");
    return purchaseAsJsonCreatorApp({
      purchase,
      link,
      seller,
      purchaser: purchase.purchaser_id == null ? null : (userById.get(purchase.purchaser_id) ?? null),
      productHasVariants: withVariants.has(link.id),
      productThumbnailUrl: thumbnails.get(link.id) ?? null,
      now,
      recurrenceLabel: purchase.subscription_id == null ? undefined : recurrenceLabels.get(purchase.subscription_id),
    });
  });
}

// Refund::TERMINAL_FAILURE_STATUSES
const TERMINAL_FAILURE_STATUSES = ["failed", "canceled"];

// Purchase#amount_refunded_cents per purchase id: `refunds.effective.sum(:amount_cents)`, a failed or canceled refund counting
// unless its balance debits were reversed. A `balance_reversed_on_failure` that is not a boolean compares differently in SQL
// (`->>`) and in Ruby truthiness, so it is Rails'.
export async function amountRefundedCentsByPurchase(purchaseIds: bigint[]): Promise<Map<bigint, number>> {
  const totals = new Map<bigint, number>();
  if (purchaseIds.length === 0) return totals;
  const rows = await selectRows<{
    purchase_id: bigint;
    amount_cents: number | null;
    status: string | null;
    json_data: string | null;
  }>(
    Prisma.sql`SELECT ${column("refunds", "purchase_id")}, ${column("refunds", "amount_cents")}, ${column("refunds", "status")}, ${column("refunds", "json_data")} FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} IN (${Prisma.join(purchaseIds)})`,
  );
  for (const row of rows) {
    let data: unknown = {};
    if (typeof row.json_data === "string" && row.json_data !== "") {
      try {
        data = JSON.parse(row.json_data);
      } catch {
        throw new NotPortedError("a refund whose json_data is not JSON");
      }
    }
    if (data !== null && (typeof data !== "object" || Array.isArray(data)))
      throw new NotPortedError("a refund whose json_data is not a hash");
    const reversed = data === null ? undefined : (data as Record<string, unknown>).balance_reversed_on_failure;
    if (reversed !== undefined && reversed !== null && typeof reversed !== "boolean")
      throw new NotPortedError("a refund whose balance_reversed_on_failure is not a boolean");
    const failed = row.status !== null && TERMINAL_FAILURE_STATUSES.includes(row.status);
    if (failed && reversed === true) continue;
    const id = BigInt(row.purchase_id);
    totals.set(id, (totals.get(id) ?? 0) + Number(row.amount_cents ?? 0));
  }
  return totals;
}

// Purchase#alive_original_product_review.try(:rating) for a purchase that is neither a gift sender's nor a membership's: its own review
// (product_reviews.purchase_id is unique). A purchase without a review is absent from the map.
export async function ratingByPurchase(purchaseIds: bigint[]): Promise<Map<bigint, number | null>> {
  const ratings = new Map<bigint, number | null>();
  if (purchaseIds.length === 0) return ratings;
  const rows = await selectRows<{ purchase_id: bigint; rating: number | null }>(
    Prisma.sql`SELECT ${column("product_reviews", "purchase_id")}, ${column("product_reviews", "rating")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} IN (${Prisma.join(purchaseIds)}) AND ${column("product_reviews", "deleted_at")} IS NULL`,
  );
  for (const row of rows) ratings.set(BigInt(row.purchase_id), row.rating === null ? null : Number(row.rating));
  return ratings;
}
