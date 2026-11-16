// Port of app/sidekiq/purchase_refund_requests/escalate_overdue_job.rb up to `escalate!`: the candidate scan with its preloads, the
// business-day deadline and the :buyer_refund_requests check run in Node. The first request that is due for a seller with the feature
// on goes back to Rails whole, because `escalate!` mails support and only then writes; nothing before it has written.
// Golden: __fixtures__/purchase-refund-requests-escalate-overdue-job.golden.json
// (scripts/golden/purchase-refund-requests-escalate-overdue-job.rb).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { evaluateFeature, parseGateValues, readFeatureDoc, userActor } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { addDays, ago, toCalendarDate, wday, type CalendarDate } from "../../server/models/concerns/ruby-time.ts";
import { connectedTo, uncached } from "../../server/models/runtime/query-cache.ts";
import { column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const REQUESTS = "purchase_refund_requests";
const PURCHASES = "purchases";
const ESCALATION_BUSINESS_DAYS = 2;
const BATCH_SIZE = 1000;
const FEATURE = "buyer_refund_requests";
const PERCENT = 100;
const SATURDAY = 6;
const SUNDAY = 0;

type Id = bigint | number;
type RequestRow = { id: Id; purchase_id: Id; created_at: Date };
type PurchaseRow = { id: Id; link_id: Id | null; seller_id: Id | null };

const isWeekend = (date: CalendarDate) => wday(date) === SATURDAY || wday(date) === SUNDAY;

// PurchaseRefundRequest.escalation_deadline_from(created_at).end_of_day, as the first instant after it: end_of_day is 23:59:59.999999999.
export function escalationDeadlineEnd(createdAt: Date): Date {
  let deadline = toCalendarDate(createdAt);
  for (let i = 0; i < ESCALATION_BUSINESS_DAYS; i += 1) {
    deadline = addDays(deadline, 1);
    while (isWeekend(deadline)) deadline = addDays(deadline, 1);
  }
  const next = addDays(deadline, 1);
  return new Date(Date.UTC(next.year, next.month - 1, next.day));
}

const unique = <T>(values: (T | null)[]) => [...new Set(values.filter((v): v is T => v !== null))];

// `includes(purchase: [:link, :seller])` preloads: purchases, then their products and sellers, one statement each. The purchases come
// back in the table's order, which is the order the ids of the next two lists are taken in.
async function preload(requests: RequestRow[]): Promise<Map<string, PurchaseRow>> {
  const ids = unique(requests.map((r) => r.purchase_id));
  const purchases = await selectRows<PurchaseRow>(
    Prisma.sql`SELECT ${table(PURCHASES)}.* FROM ${table(PURCHASES)} WHERE ${columnIn(PURCHASES, "id", ids)}`,
  );
  const linkIds = unique(purchases.map((p) => p.link_id));
  if (linkIds.length > 0)
    await selectRows(Prisma.sql`SELECT \`links\`.* FROM \`links\` WHERE ${columnIn("links", "id", linkIds)}`);
  const sellerIds = unique(purchases.map((p) => p.seller_id));
  if (sellerIds.length > 0)
    await selectRows(Prisma.sql`SELECT \`users\`.* FROM \`users\` WHERE ${columnIn("users", "id", sellerIds)}`);
  return new Map(purchases.map((p) => [String(p.id), p]));
}

// Feature.active?(:buyer_refund_requests, seller). A percentage of time rolls per call and an expression gate is not ported: both go back.
async function featureActive(redis: Pick<Redis, "hgetall">, sellerId: Id | null): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(FEATURE, redis as Redis));
  if (values.expression !== undefined && values.expression !== null)
    throw new HandBackToRuby(`${FEATURE} uses an expression gate`);
  const actor = sellerId === null ? null : userActor(sellerId);
  const opensBeforeTime = evaluateFeature(FEATURE, { ...values, percentageOfTime: 0 }, actor);
  if (opensBeforeTime) return true;
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT)
    throw new HandBackToRuby(`${FEATURE} is enabled for a percentage of time`);
  return values.percentageOfTime >= PERCENT;
}

export const purchaseRefundRequestsEscalateOverdueJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: { redis?: () => Pick<Redis, "hgetall"> } = {},
) =>
  modelJob({ min: 0, max: 0 }, async (_args, deps) => {
    const redis = (extras.redis ?? (() => getRedis("main")))();
    // with_primary_database: a lagging replica could show a request as unescalated after the last run set it.
    await connectedTo("writing", () =>
      findInBatches<RequestRow>(
        REQUESTS,
        Prisma.sql`${column(REQUESTS, "escalated_at")} IS NULL AND ${column(REQUESTS, "created_at")} <= ${ago({ days: ESCALATION_BUSINESS_DAYS }, deps.now())} AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL)`,
        BATCH_SIZE,
        async (requests) => {
          // The batch's preloads skip the query cache with the scan (`skip_query_cache!`); the block below does not.
          const purchases = await uncached(() => preload(requests));
          for (const request of requests) {
            // The scan keeps only requests with no escalation, refund or chargeback, so `status` is "requested".
            if (deps.now().getTime() < escalationDeadlineEnd(request.created_at).getTime()) continue;
            const sellerId = purchases.get(String(request.purchase_id))?.seller_id ?? null;
            if (!(await featureActive(redis, sellerId))) continue;
            throw new HandBackToRuby("a refund request that is due for escalation");
          }
        },
        null,
        Prisma.sql`INNER JOIN ${table(PURCHASES)} ON ${column(PURCHASES, "id")} = ${column(REQUESTS, "purchase_id")}`,
      ),
    );
  })(overrides);

export const purchaseRefundRequestsEscalateOverdueJob = purchaseRefundRequestsEscalateOverdueJobWith();
