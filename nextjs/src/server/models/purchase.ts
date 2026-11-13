// Read side of app/models/purchase.rb: the scopes and predicates the ported jobs use, each pinned to
// the statements Rails sends (golden: worker/jobs/__fixtures__/purchase-reads-jobs.golden.json). Rows
// are plain Prisma rows from `SELECT purchases.*`; nothing here writes a purchases row.
// WS-34's search document (search/documents/purchase.ts) has its own reads of the same table.
import { Prisma, type Purchase } from "@prisma/client";

import { PurchaseFlags } from "../search/flags.ts";

import { ago, truncateToSeconds } from "./concerns/ruby-time.ts";
import { RecordNotFound } from "./runtime/errors.ts";
import { uncached } from "./runtime/query-cache.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import {
  URL_REDIRECTS,
  TIME_TO_WATCH_RENTED_PRODUCT_AFTER_FIRST_PLAY,
  TIME_TO_WATCH_RENTED_PRODUCT_AFTER_PURCHASE,
} from "./url-redirect.ts";
import { NotPortedError } from "./user.ts";

export const PURCHASES = "purchases";
// ActiveRecord::Batches::DEFAULT_BATCH_SIZE
const BATCH_SIZE = 1_000;

const stateIs = (state: string) => Prisma.sql`${column(PURCHASES, "purchase_state")} = ${state}`;

// Scopes, as `where` fragments to join with AND.
export const purchaseScopes = {
  // scope :successful
  successful: () => stateIs("successful"),
  // scope :in_progress
  inProgress: () => stateIs("in_progress"),
  // `where(created_at: range)` with an inclusive range (TimestampScopes' created_between). The
  // column is datetime(0), so ActiveRecord floors both ends to the second.
  createdBetween: (range: { begin: Date; end: Date }) =>
    Prisma.sql`${column(PURCHASES, "created_at")} BETWEEN ${truncateToSeconds(range.begin)} AND ${truncateToSeconds(range.end)}`,
};

// A job argument as `Purchase.find` takes it: an Integer, or the digits of one (ActiveRecord casts
// the string). Anything else is a Ruby error Node does not reproduce.
export function purchaseIdFrom(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]{1,15}$/u.test(value)) return BigInt(value);
  throw new NotPortedError(`Purchase.find(${JSON.stringify(value)})`, "purchase_id is not an Integer");
}

// Purchase.find_by(id:)
export async function findPurchase(id: bigint): Promise<Purchase | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${PURCHASES}\`.*`)} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "id")} = ${id} LIMIT 1`,
  );
  return row ? castRow<Purchase>("Purchase", row) : null;
}

// Purchase.find(id)
export async function findPurchaseBang(id: bigint): Promise<Purchase> {
  const purchase = await findPurchase(id);
  if (!purchase) throw new RecordNotFound(`Couldn't find Purchase with 'id'=${String(id)}`);
  return purchase;
}

// `Purchase.successful.where(created_at: range).count`
export async function countSuccessfulCreatedBetween(range: { begin: Date; end: Date }): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table(PURCHASES)} WHERE ${purchaseScopes.successful()} AND ${purchaseScopes.createdBetween(range)}`,
  );
  return Number(row!["COUNT(*)"]);
}

// The first batch of a `find_each` over `from`/`where`, which is as far as a job gets that hands
// the rest back to Rails. find_each's batch loads skip the query cache.
async function firstBatch(clauses: { joins?: Prisma.Sql; where: Prisma.Sql }): Promise<Purchase[]> {
  const rows = await uncached(() =>
    selectRows(
      Prisma.sql`SELECT ${Prisma.raw(`\`${PURCHASES}\`.*`)} FROM ${table(PURCHASES)} ${clauses.joins ?? Prisma.empty}WHERE ${clauses.where} ORDER BY ${column(PURCHASES, "id")} ASC LIMIT ${Prisma.raw(String(BATCH_SIZE))}`,
    ),
  );
  return rows.map((row) => castRow<Purchase>("Purchase", row));
}

// `user.purchases.find_each`, first batch (`has_many :purchases, foreign_key: :purchaser_id`).
export function purchasesOfPurchaserFirstBatch(purchaserId: bigint): Promise<Purchase[]> {
  return firstBatch({ where: Prisma.sql`${column(PURCHASES, "purchaser_id")} = ${purchaserId}` });
}

// `Purchase.rentals_to_expire.find_each`, first batch.
export function rentalsToExpireFirstBatch(now: Date): Promise<Purchase[]> {
  const redirects = (name: string) => column(URL_REDIRECTS, name);
  return firstBatch({
    joins: Prisma.sql`INNER JOIN ${table(URL_REDIRECTS)} ON ${redirects("purchase_id")} = ${column(PURCHASES, "id")} `,
    where: Prisma.sql`${column(PURCHASES, "rental_expired")} = ${false} AND (url_redirects.created_at < ${ago(TIME_TO_WATCH_RENTED_PRODUCT_AFTER_PURCHASE, now)} OR url_redirects.rental_first_viewed_at < ${ago(TIME_TO_WATCH_RENTED_PRODUCT_AFTER_FIRST_PLAY, now)})`,
  });
}

// `Purchase.in_progress.created_between(range)`, loaded (SyncStuckPurchasesJob iterates it with `each`).
export async function inProgressCreatedBetween(range: { begin: Date; end: Date }): Promise<Purchase[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${PURCHASES}\`.*`)} FROM ${table(PURCHASES)} WHERE ${purchaseScopes.inProgress()} AND ${purchaseScopes.createdBetween(range)}`,
  );
  return rows.map((row) => castRow<Purchase>("Purchase", row));
}

// CreateMissingPurchaseEventsWorker's relation, walked the way `find_each` does: successful purchases
// created on `day` (a `YYYY-MM-DD` string; Date#to_s) and not preorders, with no events row. `each`
// creates the missing event, so the next batch is keyed on the last id rather than re-read from the start.
export async function successfulWithoutEventsEach(
  day: string,
  nextDay: string,
  each: (purchase: Purchase) => Promise<void>,
): Promise<void> {
  let after: bigint | number | null = null;
  for (;;) {
    const idCondition: Prisma.Sql =
      after === null ? Prisma.empty : Prisma.sql` AND ${column(PURCHASES, "id")} > ${after}`;
    const batch: Purchase[] = await firstBatch({
      joins: Prisma.sql`LEFT OUTER JOIN ${table("events")} ON ${column("events", "purchase_id")} = ${column(PURCHASES, "id")} `,
      where: Prisma.sql`${purchaseScopes.successful()} AND (purchases.created_at >= ${day} and purchases.created_at < ${nextDay}) AND (purchases.preorder_id is null and events.id is null)${idCondition}`,
    });
    for (const purchase of batch) await each(purchase);
    if (batch.length < BATCH_SIZE) return;
    after = batch.at(-1)!.id;
  }
}

// Purchase#refunded? (stripe_refunded?)
export const isRefunded = (purchase: Purchase) => purchase.stripe_refunded === true;
// Purchase#chargedback?
export const isChargedback = (purchase: Purchase) => purchase.chargeback_date != null;
// Purchase#chargedback_not_reversed?
export const isChargedbackNotReversed = (purchase: Purchase) =>
  isChargedback(purchase) && !PurchaseFlags.isSet(purchase.flags, "chargeback_reversed");
// Purchase#chargedback_not_reversed_or_refunded?
export const isChargedbackNotReversedOrRefunded = (purchase: Purchase) =>
  isChargedbackNotReversed(purchase) || isRefunded(purchase);

// Purchase::Reviews::COUNTS_REVIEWS_STATES
const COUNTS_REVIEWS_STATES = ["successful", "gift_receiver_purchase_successful", "not_charged"];

// Purchase#allows_review_to_be_counted? (`allows_reviews(permit_recurring_charges: false)`), and Purchase#allows_review? with
// `permitRecurringCharges`: a pure read of the row, every clause runs and none of them queries.
export function allowsReviewToBeCounted(purchase: Purchase, permitRecurringCharges = false): boolean {
  const flag = (name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags, name);
  let allowed = COUNTS_REVIEWS_STATES.includes(purchase.purchase_state ?? "");
  allowed &&= !flag("should_exclude_product_review");
  // not_charged_and_not_free_trial?
  allowed &&= !(purchase.purchase_state === "not_charged" && !flag("is_free_trial_purchase"));
  allowed &&= !flag("is_gift_sender_purchase");
  allowed &&= purchase.stripe_refunded !== true;
  allowed &&= purchase.stripe_partially_refunded !== true || !flag("is_bundle_product_purchase");
  allowed &&= purchase.chargeback_date == null;
  if (!permitRecurringCharges)
    allowed &&= purchase.subscription_id == null || flag("is_original_subscription_purchase");
  allowed &&= !flag("is_access_revoked") || (purchase.price_cents ?? 0) > 0;
  allowed &&= !flag("is_commission_completion_purchase");
  return allowed;
}
