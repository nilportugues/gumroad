// Port of app/sidekiq/repair_order_charge_outcomes_job.rb: the hourly backstop that re-derives Order#record_charge_outcome! for orders
// whose RecordOrderChargeOutcomeJob enqueue was lost. Two passes (a primary-id walk of recent failed purchases from a Redis mark, and a
// lap over older failed orders from a Redis cursor and ceiling) read candidates inside `timeoutQueries` and then repair each.
// Golden: __fixtures__/repair-order-charge-outcomes-job.golden.json (scripts/golden/repair-order-charge-outcomes-job.rb).
//
// Redis marks are written when the read phase is over, in the order Rails writes them, so a run that goes back to Rails leaves them
// untouched. Whatever the small recording cannot reach goes back to Rails whole before any write: a walk that stops on its page or
// candidate budget (40 pages, 2,000 ids), and a Redis read that fails (Rails reports it and continues from 0).
import { Prisma } from "@prisma/client";
import type { Order } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago, truncateToSeconds } from "../../server/models/concerns/ruby-time.ts";
import { findOneBy } from "../../server/models/row-reads.ts";
import { timeoutQueries } from "../../server/models/runtime/max-execution-time.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { column, columnIn, columnNotIn, selectRows, table } from "../../server/models/sql.ts";

import { recordChargeOutcome } from "./record-order-charge-outcome-job.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

const ORDERS = "orders";
const PURCHASES = "purchases";
const ORDER_PURCHASES = "order_purchases";
const RECENT_WINDOW = { days: 3 };
const MAX_BACKLOG_SCANNED = 2_000;
const FAILED_ORDER_ID_BATCH = 1_000;
const MAX_FAILED_ORDER_BATCHES = 40;
// 2.minutes.to_i
const QUERY_TIME_BUDGET = 120;
// Order flag 2 (partially_successful)
const PARTIALLY_SUCCESSFUL = 1 << 1;
// Purchase::CHECKOUT_FAILURE_STATES
const CHECKOUT_FAILURE_STATES = ["failed", "preorder_authorization_failed", "gift_receiver_purchase_failed"];

// RedisKey.order_charge_outcome_repair_*
const CURSOR_KEY = "order_charge_outcome_repair:cursor";
const LAP_CEILING_KEY = "order_charge_outcome_repair:lap_ceiling";
const RECENT_MARK_KEY = "order_charge_outcome_repair:recent_mark";

export type RepairDeps = {
  // $redis.get / $redis.set on the main database
  redisGet: (key: string) => Promise<string | null>;
  redisSet: (key: string, value: string) => Promise<void>;
  // ErrorNotifier.notify
  notify: (error: unknown) => void;
};

const defaultRepairDeps: RepairDeps = {
  redisGet: (key) => getRedis("main").get(key),
  redisSet: async (key, value) => {
    await getRedis("main").set(key, value);
  },
  notify: (error) => notifyError(error),
};

type Id = bigint;

// String#to_i of what a mark holds: leading digits, 0 for anything else.
const toI = (value: string | null): Id => {
  const digits = /^\s*([-+]?\d+)/u.exec(value ?? "")?.[1];
  return digits === undefined ? 0n : BigInt(digits);
};
const sortIds = (ids: Id[]) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const uniq = (ids: Id[]) => [...new Set(ids)];
const slices = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const pluckIds = async (sql: Prisma.Sql): Promise<Id[]> =>
  (await selectRows<Record<string, unknown>>(sql)).map((row) => BigInt(Object.values(row)[0] as bigint | number));
const aggregate = async (sql: Prisma.Sql): Promise<Id | null> => {
  const value = Object.values((await selectRows<Record<string, unknown>>(sql))[0] ?? {})[0];
  return value === null || value === undefined ? null : BigInt(value as bigint | number);
};

// `where("... > ?", id)` quotes the Integer as a string literal.
const quoted = (id: Id) => Prisma.raw(`'${String(id)}'`);
const purchases = (name: string) => column(PURCHASES, name);
const orderPurchases = (name: string) => column(ORDER_PURCHASES, name);
// Purchase.checkout_failed
const CHECKOUT_FAILED = columnIn(PURCHASES, "purchase_state", CHECKOUT_FAILURE_STATES);

export const repairOrderChargeOutcomesJobWith = (overrides: Partial<JobDeps & RepairDeps> = {}) =>
  modelJob({ min: 0 }, async (_args, jobDeps) => {
    const deps = { ...defaultRepairDeps, ...overrides };
    await connectedTo("writing", () => timeoutQueries(QUERY_TIME_BUDGET, () => repair(jobDeps, deps)));
  })(overrides);

async function repair(jobDeps: JobDeps, deps: RepairDeps): Promise<void> {
  const now = jobDeps.now();
  const recentSince = () => ago(RECENT_WINDOW, now);

  // Marks written by this run, applied once the reads are done (see the header).
  const pending: [string, string][] = [];
  const written = new Map<string, string>();
  const write = (key: string, value: Id) => {
    pending.push([key, String(value)]);
    written.set(key, String(value));
  };
  const read = async (key: string): Promise<Id> => {
    if (written.has(key)) return toI(written.get(key)!);
    try {
      return toI(await deps.redisGet(key));
    } catch {
      throw new HandBackToRuby("a Redis read failed, which Rails reports and answers with 0");
    }
  };
  const flush = async () => {
    for (const [key, value] of pending.splice(0)) {
      try {
        await deps.redisSet(key, value);
      } catch (error) {
        deps.notify(error);
      }
    }
  };

  const orderIdsForPurchases = async (purchaseIds: Id[]): Promise<Id[]> => {
    const orderIds: Id[] = [];
    for (const slice of slices(purchaseIds, FAILED_ORDER_ID_BATCH)) {
      orderIds.push(
        ...(await pluckIds(
          Prisma.sql`SELECT ${orderPurchases("order_id")} FROM ${table(ORDER_PURCHASES)} WHERE ${columnIn(ORDER_PURCHASES, "purchase_id", slice)}`,
        )),
      );
    }
    return uniq(orderIds);
  };

  // `created_at` is `{ from }` (since..) or `{ before }` (...cutoff).
  const filterCandidates = async (orderIds: Id[], createdAt: { from: Date } | { before: Date }): Promise<Id[]> => {
    if (orderIds.length === 0) return [];
    const withSibling: Id[] = [];
    for (const slice of slices(orderIds, FAILED_ORDER_ID_BATCH)) {
      withSibling.push(
        ...(await pluckIds(
          Prisma.sql`SELECT DISTINCT ${orderPurchases("order_id")} FROM ${table(ORDER_PURCHASES)} INNER JOIN ${table(PURCHASES)} ON ${purchases("id")} = ${orderPurchases("purchase_id")} WHERE ${columnIn(ORDER_PURCHASES, "order_id", slice)} AND ${columnNotIn(PURCHASES, "purchase_state", CHECKOUT_FAILURE_STATES)}`,
        )),
      );
    }
    if (withSibling.length === 0) return [];
    const out: Id[] = [];
    for (const slice of slices(withSibling, FAILED_ORDER_ID_BATCH)) {
      const range =
        "from" in createdAt
          ? Prisma.sql`${column(ORDERS, "created_at")} >= ${createdAt.from}`
          : Prisma.sql`${column(ORDERS, "created_at")} < ${createdAt.before}`;
      out.push(
        ...(await pluckIds(
          Prisma.sql`SELECT ${column(ORDERS, "id")} FROM ${table(ORDERS)} WHERE ((${column(ORDERS, "flags")} & ${Prisma.raw(String(PARTIALLY_SUCCESSFUL))} = 0)) AND ${columnIn(ORDERS, "id", slice)} AND ${range}`,
        )),
      );
    }
    return sortIds(out);
  };

  const recentPage = async (afterId: Id, since: Date): Promise<{ ids: Id[]; cursor: Id; exhausted: boolean }> => {
    const ids: Id[] = [];
    let cursor = afterId;
    let exhausted = false;
    let batches = 0;
    while (ids.length < MAX_BACKLOG_SCANNED && batches < MAX_FAILED_ORDER_BATCHES) {
      const purchaseIds = await pluckIds(
        Prisma.sql`SELECT ${purchases("id")} FROM ${table(PURCHASES)} WHERE ${CHECKOUT_FAILED} AND (purchases.id > ${quoted(cursor)}) ORDER BY ${purchases("id")} ASC LIMIT ${Prisma.raw(String(FAILED_ORDER_ID_BATCH))}`,
      );
      if (purchaseIds.length === 0) {
        exhausted = true;
        break;
      }
      batches += 1;
      const batchCandidates = await filterCandidates(await orderIdsForPurchases(purchaseIds), { from: since });
      if (ids.length + batchCandidates.length > MAX_BACKLOG_SCANNED) {
        throw new HandBackToRuby("the recent walk fills its candidate budget mid-page");
      }
      cursor = purchaseIds.at(-1)!;
      ids.push(...batchCandidates);
    }
    if (!exhausted) throw new HandBackToRuby("the recent walk stops on its page or candidate budget");
    return { ids, cursor, exhausted };
  };

  const recentMarkStart = async (since: Date): Promise<Id> => {
    const mark = await read(RECENT_MARK_KEY);
    if (mark > 0n) return mark;
    const floor = await aggregate(
      Prisma.sql`SELECT MIN(${purchases("id")}) FROM ${table(PURCHASES)} WHERE ${CHECKOUT_FAILED} AND ${purchases("created_at")} >= ${truncateToSeconds(since)}`,
    );
    if (floor !== null && floor > 0n) return floor - 1n;
    return (await aggregate(Prisma.sql`SELECT MAX(${purchases("id")}) FROM ${table(PURCHASES)}`)) ?? 0n;
  };

  const recentCandidateIds = async (): Promise<{ ids: Id[]; after: Id; scanTo: Id }> => {
    const since = recentSince();
    let afterId = await recentMarkStart(since);
    let page = await recentPage(afterId, since);
    if (page.ids.length === 0 && page.exhausted && afterId > 0n) {
      write(RECENT_MARK_KEY, 0n);
      afterId = await recentMarkStart(since);
      page = await recentPage(afterId, since);
    }
    return { ids: sortIds(uniq(page.ids)).slice(0, MAX_BACKLOG_SCANNED), after: afterId, scanTo: page.cursor };
  };

  const orderIdsWithCheckoutFailed = (afterId: Id, ceiling: Id | null): Promise<Id[]> =>
    pluckIds(
      Prisma.sql`SELECT ${orderPurchases("order_id")} FROM ${table(ORDER_PURCHASES)} INNER JOIN ${table(PURCHASES)} ON ${purchases("id")} = ${orderPurchases("purchase_id")} WHERE ${CHECKOUT_FAILED} AND (order_purchases.order_id > ${quoted(afterId)})${ceiling !== null && ceiling > 0n ? Prisma.sql` AND (order_purchases.order_id <= ${quoted(ceiling)})` : Prisma.empty} ORDER BY order_purchases.order_id LIMIT ${Prisma.raw(String(FAILED_ORDER_ID_BATCH))}`,
    ).then(uniq);

  const backlogPage = async (afterId: Id, ceiling: Id | null, limit: number) => {
    const ids: Id[] = [];
    let cursor = afterId;
    let exhausted = false;
    let batches = 0;
    while (ids.length < limit && batches < MAX_FAILED_ORDER_BATCHES) {
      const failedOrderIds = await orderIdsWithCheckoutFailed(cursor, ceiling);
      if (failedOrderIds.length === 0) {
        exhausted = true;
        break;
      }
      batches += 1;
      cursor = failedOrderIds.at(-1)!;
      ids.push(...(await filterCandidates(failedOrderIds, { before: recentSince() })));
    }
    if (!exhausted) throw new HandBackToRuby("the backlog walk stops on its page or candidate budget");
    return { ids: ids.slice(0, limit), cursor, exhausted };
  };

  const lapCeiling = async (afterId: Id): Promise<Id> => {
    const newCeiling = async () => {
      const ceiling = (await aggregate(Prisma.sql`SELECT MAX(${column(ORDERS, "id")}) FROM ${table(ORDERS)}`)) ?? 0n;
      write(LAP_CEILING_KEY, ceiling);
      return ceiling;
    };
    if (afterId === 0n) return newCeiling();
    const ceiling = await read(LAP_CEILING_KEY);
    return ceiling === 0n ? newCeiling() : ceiling;
  };

  const backlogCandidateIds = async (remainingBudget: number): Promise<Id[]> => {
    if (remainingBudget <= 0) return [];
    let afterId = await read(CURSOR_KEY);
    let ceiling = await lapCeiling(afterId);
    let page = await backlogPage(afterId, ceiling, remainingBudget);
    if (page.ids.length === 0 && page.exhausted && afterId > 0n) {
      write(CURSOR_KEY, 0n);
      afterId = 0n;
      ceiling = await lapCeiling(0n);
      page = await backlogPage(0n, ceiling, remainingBudget);
    }
    if (page.ids.length > 0) {
      const last = page.ids.at(-1)!;
      write(CURSOR_KEY, page.ids.length < remainingBudget ? (last > page.cursor ? last : page.cursor) : last);
    } else if (!page.exhausted && page.cursor > afterId) {
      write(CURSOR_KEY, page.cursor);
    }
    return page.ids;
  };

  const recent = await recentCandidateIds();
  const backlogIds = await backlogCandidateIds(MAX_BACKLOG_SCANNED - recent.ids.length);

  await flush();

  for (const id of uniq([...recent.ids, ...backlogIds])) {
    const order = await findOneBy<Order>("Order", "id", id);
    if (order) await recordChargeOutcome(order, jobDeps.now());
  }

  // Saved only after the repairs land: saving earlier would skip purchases whose repair never ran.
  if (recent.scanTo > recent.after) {
    write(RECENT_MARK_KEY, recent.scanTo);
    await flush();
  }
}

export const repairOrderChargeOutcomesJob = repairOrderChargeOutcomesJobWith();
