// Port of app/sidekiq/update_sales_related_products_infos_job.rb: after a sale (or its reversal) the pairwise counters between the
// purchased product and the other products the buyer owns are bumped, and a cache refresh is scheduled for each product a few days out.
// An `increment` argument is read with Ruby's truthiness (null and false reverse the sale, anything else counts it); a purchase id
// that is not an Integer or its digits, and a delay Redis holds beyond what Time arithmetic here covers, hand back before any write.
// Golden: __fixtures__/update-sales-related-products-infos-job.golden.json (scripts/golden/update-sales-related-products-infos-job.rb).
import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { Purchase } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { isFeatureEnabled } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { pushBulkWith } from "../../server/jobs/push-bulk.ts";
import { currentJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import { rubyStringToBigInt } from "../../server/models/concerns/ruby-numeric.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { COUNTED_PURCHASES, updateSalesCounts } from "../../server/models/sales-related-products-info.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

const FEATURE = "update_sales_related_products_infos";
const DELAY_KEY = "update_cached_srpis_job_delay_hours";
const DEFAULT_DELAY_HOURS = 72;
const RELATED_PRODUCTS_PER_PURCHASE_LIMIT = 100;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;
// Far beyond any delay an operator sets; past it Time arithmetic stops being a plain addition of seconds.
const MAX_DELAY_HOURS = 1_000_000n;
const REFRESH_JOB = "UpdateCachedSalesRelatedProductsInfosJob";

export type UpdateSalesRelatedProductsInfosDeps = {
  featureActive: (name: string) => Promise<boolean>;
  redis: () => Pick<Redis, "get">;
  // Kernel#rand(max)
  randomBelow: (max: number) => number;
  // Kernel.rand, the retry jitter
  random: () => number;
  sleep: (seconds: number) => Promise<void>;
};

const defaultExtras: UpdateSalesRelatedProductsInfosDeps = {
  featureActive: (name) => isFeatureEnabled(name),
  redis: () => getRedis("main"),
  randomBelow: (max) => randomInt(max),
  random: () => Math.random(),
  sleep: (seconds) => sleep(seconds * 1000),
};

async function delayHours(redis: Pick<Redis, "get">): Promise<bigint> {
  const stored = await redis.get(DELAY_KEY);
  if (stored === null) return BigInt(DEFAULT_DELAY_HOURS);
  const hours = rubyStringToBigInt(stored);
  if (hours > MAX_DELAY_HOURS || hours < -MAX_DELAY_HOURS)
    throw new HandBackToRuby("an update_cached_srpis_job_delay_hours past a million");
  return hours;
}

export const updateSalesRelatedProductsInfosJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<UpdateSalesRelatedProductsInfosDeps> = {},
) => {
  const extra = { ...defaultExtras, ...extras };
  return modelJob({ min: 1, max: 2 }, async (args, deps) => {
    // `return if Feature.inactive?(...)` runs before the purchase is read.
    if (!(await extra.featureActive(FEATURE))) return;

    const purchaseId = await beforeSideEffects(() => recordIdFrom(args[0], "Purchase.find"));
    // `increment = true`, then Ruby truthiness for whatever was given.
    const increment = args.length < 2 ? true : args[1] !== null && args[1] !== false;

    const purchase = await findByIdBang<Purchase>("Purchase", purchaseId);
    const productId = purchase.link_id!;
    const emailCondition =
      purchase.email === null
        ? Prisma.sql`${column("purchases", "email")} IS NULL`
        : Prisma.sql`${column("purchases", "email")} = ${purchase.email}`;
    const rows = await selectRows<{ link_id: bigint | number }>(
      Prisma.sql`SELECT ${column("purchases", "link_id")} FROM ${table("purchases")} WHERE ${COUNTED_PURCHASES} AND ${emailCondition} AND ${column("purchases", "link_id")} != ${productId} GROUP BY ${column("purchases", "link_id")} ORDER BY MAX(${column("purchases", "id")}) DESC LIMIT ${Prisma.raw(String(RELATED_PRODUCTS_PER_PURCHASE_LIMIT))}`,
    );
    const relatedProductIds = rows.map((row) => BigInt(row.link_id));
    if (relatedProductIds.length === 0) return;

    // Read ahead of the writes so a delay that has to be handed back is found before any pair is counted.
    const baseDelayHours = await delayHours(extra.redis());
    await updateSalesCounts(productId, relatedProductIds, increment, {
      now: deps.now,
      random: extra.random,
      sleep: extra.sleep,
    });

    const refreshArgs = [productId, ...relatedProductIds].map((id) => [id]);
    const from = Math.floor(deps.now().getTime() / 1000) + Number(baseDelayHours) * SECONDS_PER_HOUR;
    // `base_delay.hours.from_now.to_i + rand(24.hours.to_i)`, drawn for each product in turn
    const at = refreshArgs.map(() => from + extra.randomBelow(SECONDS_PER_DAY));
    await pushBulkWith(currentJobsRuntime(), { class: REFRESH_JOB, args: refreshArgs, queue: "low", at });
  })(overrides);
};

export const updateSalesRelatedProductsInfosJob = updateSalesRelatedProductsInfosJobWith();
