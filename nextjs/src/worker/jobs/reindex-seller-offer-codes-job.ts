// Port of the coordination half of app/sidekiq/reindex_seller_offer_codes_job.rb and of reindex_seller_offer_codes_recovery_job.rb: the
// per-seller Redis lock, the cooldown and the idle exits, each re-queueing the job five seconds out exactly as Ruby does. A run that
// has products to index (targeted ids or a catalogue pass) belongs to ProductOfferCodeIndexingService, which writes Elasticsearch and
// stays with Rails: the lock is released and the job handed back before anything else is written, so Ruby starts from the same state.
// Golden: __fixtures__/reindex-seller-offer-codes-job.golden.json (scripts/golden/reindex-seller-offer-codes-job.rb); the service was
// replaced by a recorder there.
import { randomBytes } from "node:crypto";

import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { rubyTimeToF } from "../../server/models/concerns/ruby-time.ts";
import type { RetriesExhausted } from "../retry.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

const INTERVAL_SECONDS = 5;
const LOCK_TTL_SECONDS = 10 * 60;
const RECOVERY_DELAY_SECONDS = 60 * 60;
const REINDEX_JOB = "ReindexSellerOfferCodesJob";
const RECOVERY_JOB = "ReindexSellerOfferCodesRecoveryJob";
const RELEASE_LOCK = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end";

export type ReindexDeps = { redis: () => Pick<Redis, "set" | "get" | "zcard" | "exists" | "eval"> };

const defaultReindexDeps: ReindexDeps = { redis: () => getRedis("main") };

// `"offer_code_index:#{seller_id}"`: an Integer or String id interpolates as written, nil as "". Other shapes (a Float prints as Ruby
// formats it) are not ported.
function keyFor(sellerId: JsonValue): string {
  if (sellerId === null) return "offer_code_index:";
  if (typeof sellerId === "string" || typeof sellerId === "number" || typeof sellerId === "bigint") {
    if (typeof sellerId === "number" && !Number.isSafeInteger(sellerId))
      throw new HandBackToRuby("a seller id that is not an Integer");
    return `offer_code_index:${sellerId}`;
  }
  throw new HandBackToRuby("a seller id that is not an Integer or String");
}

// `String#to_f` of a stored cooldown: the leading number, 0.0 when there is none. A leading dot or sign-and-dot is not ported.
function rubyStringToF(value: string | null): number {
  if (value === null) return 0;
  const match = /^[ \t\n\v\f\r]*([+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?)/u.exec(value);
  if (match) return Number(match[1]!.replaceAll("_", ""));
  if (/^[ \t\n\v\f\r]*[+-]?\./u.test(value)) throw new HandBackToRuby("a cooldown that starts with a dot");
  return 0;
}

export async function reindexSellerOfferCodes(sellerId: JsonValue, deps: JobDeps, extra: ReindexDeps): Promise<void> {
  const key = keyFor(sellerId);
  const redis = extra.redis();
  const token = randomBytes(16).toString("hex");
  const locked = await redis.set(`${key}:lock`, token, "EX", LOCK_TTL_SECONDS, "NX");
  if (locked === null) {
    await performAsync(REINDEX_JOB, [sellerId], { delaySeconds: INTERVAL_SECONDS });
    return;
  }
  try {
    const cooldown = rubyStringToF(await redis.get(`${key}:cooldown`));
    if (cooldown > rubyTimeToF(deps.now())) {
      await performAsync(REINDEX_JOB, [sellerId], { delaySeconds: INTERVAL_SECONDS });
      return;
    }
    const targetedPending = (await redis.zcard(`${key}:products`)) > 0;
    const cataloguePending = (await redis.exists(`${key}:version`)) > 0;
    // Both the targeted batch and the catalogue scan end in the indexing service; only a seller with neither is idle.
    if (!targetedPending && !cataloguePending) return;
    throw new HandBackToRuby("ProductOfferCodeIndexingService is not ported");
  } finally {
    await redis.eval(RELEASE_LOCK, 1, `${key}:lock`, token);
  }
}

export const reindexSellerOfferCodesJobWith = (overrides: Partial<JobDeps> = {}, extras: Partial<ReindexDeps> = {}) =>
  modelJob({ min: 1 }, async ([sellerId], deps) => {
    await reindexSellerOfferCodes(sellerId as JsonValue, deps, { ...defaultReindexDeps, ...extras });
  })(overrides);

// `ReindexSellerOfferCodesJob.new.perform(seller_id)`: the re-queues are the reindex job's own.
export const reindexSellerOfferCodesRecoveryJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<ReindexDeps> = {},
) =>
  modelJob({ min: 1 }, async ([sellerId], deps) => {
    await reindexSellerOfferCodes(sellerId as JsonValue, deps, { ...defaultReindexDeps, ...extras });
  })(overrides);

// `perform_in(1.hour, message.fetch("args").first)` on the recovery job.
function recoveryAfterAnHour(): RetriesExhausted {
  return async (msg, _error, { runtime }) => {
    await enqueueWith(runtime, RECOVERY_JOB, [(msg.args as JsonValue[])[0] ?? null], {
      delaySeconds: RECOVERY_DELAY_SECONDS,
    });
  };
}

export const reindexSellerOfferCodesJob = reindexSellerOfferCodesJobWith();
export const reindexSellerOfferCodesRecoveryJob = reindexSellerOfferCodesRecoveryJobWith();
export const reindexSellerOfferCodesJobRetriesExhausted = recoveryAfterAnHour();
export const reindexSellerOfferCodesRecoveryJobRetriesExhausted = recoveryAfterAnHour();
