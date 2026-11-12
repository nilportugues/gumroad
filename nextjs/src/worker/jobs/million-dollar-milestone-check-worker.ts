// Port of app/sidekiq/million_dollar_milestone_check_worker.rb up to the announcement: the sellers with a counted sale created in the
// window two to three weeks back and no announcement yet are read 1,000 at a time, and each one's net sales come from one purchase search.
// The first seller at or over $1M goes to the announcement (the compliance info read, the Slack message, the
// `million_dollar_announcement_sent` update with its callbacks and the InternalNotificationWorker push), which stays with Rails: the job is
// handed back at that seller, after nothing but reads, so the sellers before it (all under $1M) are simply checked again. A sum Node does
// not read as a number hands back too.
// Golden: __fixtures__/million-dollar-milestone-check-worker.golden.json (scripts/golden/million-dollar-milestone-check-worker.rb); the
// announcement was replaced by an error there.
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago, truncateToSeconds } from "../../server/models/concerns/ruby-time.ts";
import { column, findInBatches, inList, table } from "../../server/models/sql.ts";
import { UserFlags } from "../../server/models/user.ts";
import { CHARGED_SALES_SEARCH_OPTIONS } from "../../server/search/creator-analytics-sales.ts";
import { PurchaseSearchService } from "../../server/search/purchase-search.ts";

import { modelJob } from "./support/job-deps.ts";

const USERS = "users";
const PURCHASES = "purchases";
const BATCH_SIZE = 1_000;
const MILLION_DOLLARS_IN_CENTS = 1_000_000_00;
// Purchase::ALL_SUCCESS_STATES
const ALL_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];
const CHARGEBACK_REVERSED_FLAG = 512;

// `User#gross_sales_cents_total_as_seller`
async function grossSalesCentsTotal(sellerId: bigint): Promise<number> {
  const result = await PurchaseSearchService.process({
    ...CHARGED_SALES_SEARCH_OPTIONS,
    seller: Number(sellerId),
    recommended: null,
    size: 0,
    aggs: {
      price_cents_total: { sum: { field: "price_cents" } },
      amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
    },
  });
  const aggregations = result.response.aggregations as Record<string, { value?: unknown } | undefined> | undefined;
  const price = aggregations?.price_cents_total?.value;
  const refunded = aggregations?.amount_refunded_cents_total?.value;
  if (typeof price !== "number" || typeof refunded !== "number")
    throw new HandBackToRuby("the sales sums are not numbers");
  return price - refunded;
}

export const millionDollarMilestoneCheckWorkerWith = modelJob({ min: 0 }, async (_args, deps) => {
  const now = deps.now();
  // Range.new(3.weeks.ago.days_ago(2), 2.weeks.ago); the column drops the fraction
  const from = truncateToSeconds(ago({ days: 23 }, now));
  const to = truncateToSeconds(ago({ weeks: 2 }, now));
  const sellers = Prisma.sql`SELECT DISTINCT ${column(PURCHASES, "seller_id")} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "created_at")} BETWEEN ${from} AND ${to} AND ${column(PURCHASES, "purchase_state")} IN ${inList(ALL_SUCCESS_STATES)} AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & ${String(CHARGEBACK_REVERSED_FLAG)} != 0))`;
  const where = Prisma.sql`(${UserFlags.condition("million_dollar_announcement_sent", false)}) AND ${column(USERS, "id")} IN (${sellers})`;

  await findInBatches<{ id: bigint }>(USERS, where, BATCH_SIZE, async (users) => {
    for (const user of users) {
      if ((await grossSalesCentsTotal(user.id)) < MILLION_DOLLARS_IN_CENTS) continue;
      throw new HandBackToRuby("the $1M announcement is not ported");
    }
  });
});

export const millionDollarMilestoneCheckWorker = millionDollarMilestoneCheckWorkerWith();
