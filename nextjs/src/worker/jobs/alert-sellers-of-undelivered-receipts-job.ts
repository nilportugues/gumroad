// Port of app/sidekiq/alert_sellers_of_undelivered_receipts_job.rb up to the first receipt old enough to judge: the stored cursor (or
// the first-run start when no receipt in the newest block was sent inside the lookback), the empty retry set and the receipt scan run
// in Node, and a scan whose first receipt is still too young to judge (or that finds none) ends by writing the cursor back unchanged.
// A receipt to judge needs its purchase, buyer and seller and ends in an enqueued digest mail, a retry set holds purchases to
// re-judge, and a first run whose newest block has a receipt inside the lookback binary-searches for its start; all three go back to
// Rails whole before any write.
// Golden: __fixtures__/alert-sellers-of-undelivered-receipts-job.golden.json (scripts/golden/alert-sellers-of-undelivered-receipts-job.rb).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { rubyToI } from "../../server/mail/mailer-info.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const EMAIL_INFOS = "email_infos";
const BATCH_SIZE = 5_000;
const MAX_RETRIES_PER_RUN = 1_000;
const PROBE_ROWS = 1_000;
const INITIAL_LOOKBACK = { days: 7 };
const BOUNDARY_SKEW = { hours: 1 };
// UndeliveredReceiptNotifier::SETTLE_GRACE
const SETTLE_GRACE = { days: 2 };
// RedisKey.undelivered_receipt_sweep_cursor, RedisKey.undelivered_receipt_pending_retry
const CURSOR_KEY = "undelivered_receipt_sweep:cursor";
const PENDING_RETRY_KEY = "undelivered_receipt_sweep:pending_retry";
// CustomerEmailInfo.name, SendgridEventInfo::RECEIPT_MAILER_METHOD
const RECEIPT_TYPE = "CustomerEmailInfo";
const RECEIPT_EMAIL_NAME = "receipt";
// String#blank?, to the whitespace JavaScript knows (it differs from Ruby's [[:space:]] at two code points)
const BLANK = /^\s*$/u;

// The Redis commands the job sends before it hands back, on the main database (`$redis`).
export type UndeliveredReceiptsRedis = Pick<Redis, "get" | "set" | "srandmember">;
export type UndeliveredReceiptsDeps = { redis: () => UndeliveredReceiptsRedis };

const infos = (name: string) => column(EMAIL_INFOS, name);

// EmailInfo.where(type:, email_name:).where(state: %w[sent bounced]).where("email_infos.id > ?", after_id)
const RECEIPTS_AFTER = (afterId: number) =>
  Prisma.sql`WHERE ${infos("type")} = ${RECEIPT_TYPE} AND ${infos("email_name")} = ${RECEIPT_EMAIL_NAME} AND ${infos("state")} IN ('sent', 'bounced') AND (email_infos.id > ${String(afterId)})`;

// Whether any row in the newest PROBE_ROWS rows was sent at or after the boundary.
async function newestBlockInWindow(boundary: Date): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM (SELECT ${Prisma.raw("`email_infos`.*")} FROM ${table(EMAIL_INFOS)} ORDER BY ${infos("id")} DESC LIMIT ${Prisma.raw(String(PROBE_ROWS))}) email_infos WHERE (email_infos.sent_at >= ${boundary}) LIMIT 1`,
  );
  return rows.length > 0;
}

// `initial_cursor` while no receipt of the newest block is inside the window; a block with one is searched for its start in Rails.
async function initialCursor(now: Date): Promise<number> {
  const [newest] = await selectRows<{ id: unknown }>(
    Prisma.sql`SELECT ${infos("id")} FROM ${table(EMAIL_INFOS)} ORDER BY ${infos("id")} DESC LIMIT 1`,
  );
  if (newest === undefined) return 0;
  if (await newestBlockInWindow(ago(BOUNDARY_SKEW, ago(INITIAL_LOOKBACK, now)))) {
    throw new HandBackToRuby("a first run whose newest receipts are inside the lookback searches for its start");
  }
  return Number(newest.id);
}

// Rails reports a Redis error and goes on without it; that report is not Node's to make.
async function redisOrHandBack<T>(what: string, command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch {
    throw new HandBackToRuby(`${what} failed`);
  }
}

export const alertSellersOfUndeliveredReceiptsJobWith = (
  overrides: Partial<JobDeps> = {},
  receipts: Partial<UndeliveredReceiptsDeps> = {},
) =>
  modelJob({ min: 0, max: 0 }, async (_args, deps) => {
    const redis = (receipts.redis ?? (() => getRedis("main")))();
    const now = deps.now();

    const stored = await redisOrHandBack("reading the sweep cursor", () => redis.get(CURSOR_KEY));
    const cursor = stored !== null && !BLANK.test(stored) ? rubyToI(stored) : await initialCursor(now);

    const pending = await redisOrHandBack("reading the retry set", () =>
      redis.srandmember(PENDING_RETRY_KEY, MAX_RETRIES_PER_RUN),
    );
    if (pending.length > 0) throw new HandBackToRuby("purchases from an earlier run wait for a retry");

    // `rows.empty?` asks the database before the rows are loaded.
    const any = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table(EMAIL_INFOS)} ${RECEIPTS_AFTER(cursor)} LIMIT 1`,
    );
    if (any.length > 0) {
      const [first] = await selectRows<{ sent_at: Date | null }>(
        Prisma.sql`SELECT ${infos("id")}, ${infos("purchase_id")}, ${infos("state")}, ${infos("sent_at")}, ${infos("delivered_at")}, ${infos("opened_at")} FROM ${table(EMAIL_INFOS)} ${RECEIPTS_AFTER(cursor)} ORDER BY ${infos("id")} ASC LIMIT ${Prisma.raw(String(BATCH_SIZE))}`,
      );
      // `judgeable?`: the first receipt too young to judge ends the scan at it.
      const judgeable = first?.sent_at instanceof Date && first.sent_at <= ago(SETTLE_GRACE, now);
      if (judgeable) throw new HandBackToRuby("a receipt old enough to judge needs its purchase, buyer and seller");
    }

    await redisOrHandBack("saving the sweep cursor", () => redis.set(CURSOR_KEY, cursor));
  })(overrides);

export const alertSellersOfUndeliveredReceiptsJob = alertSellersOfUndeliveredReceiptsJobWith();
