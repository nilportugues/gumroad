// Port of app/sidekiq/generate_merchant_center_feed_worker.rb and the coordination half of MerchantCenterFeedRun: the kill switch, the
// feed lock and its renewal, the retry five minutes out while another run holds the lock, and the shard bookkeeping read before the
// first unit. Publishing a unit is MerchantCenterFeedService (a product scan and an S3 upload), so a run that reaches it releases its
// lock and hands the job back; the progress hash is only written after a unit, so Ruby starts from the state Node found.
// Golden: __fixtures__/generate-merchant-center-feed-worker.golden.json (scripts/golden/generate-merchant-center-feed-worker.rb).
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { isFeatureEnabled } from "../../server/infra/flipper.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { selectRows } from "../../server/models/sql.ts";
import { Prisma } from "@prisma/client";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

const JOB = "GenerateMerchantCenterFeedWorker";
const DEFAULT_MAX_PRODUCTS = 100_000;
const LOCK_RETRY_DELAY_SECONDS = 5 * 60;
const LOCK_MAX_ATTEMPTS = 5;
const KILL_SWITCH = "disable_merchant_center_feed";
const LOCK_TTL_SECONDS = 15 * 60;
const FEED_LOCK_KEY = "merchant_center_feed_lock";
const FEED_PROGRESS_KEY = "merchant_center_feed_progress";
const FEED_MAX_SHARD_KEY = "merchant_center_feed_max_shard";
const SHARD_WIDTH = 1_000_000;

const LOCK_SCRIPT_RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const LOCK_SCRIPT_RENEW = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export type MerchantCenterFeedDeps = {
  redis: () => Pick<Redis, "set" | "get" | "hkeys" | "eval">;
  // Feature.active?(name)
  killSwitchEngaged: (name: string) => Promise<boolean>;
};

const defaultFeedDeps: MerchantCenterFeedDeps = {
  redis: () => getRedis("main"),
  killSwitchEngaged: (name) => isFeatureEnabled(name),
};

class GenerationInProgress extends Error {}
class LockLost extends Error {}
class KillSwitchEngaged extends Error {}

async function renewLock(redis: ReturnType<MerchantCenterFeedDeps["redis"]>, token: string): Promise<void> {
  const renewed = await redis.eval(LOCK_SCRIPT_RENEW, 1, FEED_LOCK_KEY, token, LOCK_TTL_SECONDS);
  if (Number(renewed) === 0) throw new LockLost("the Merchant Center feed lock expired mid-run");
}

// Runs in an `ensure`: a Redis error here must not replace the run's own result.
async function releaseLock(redis: ReturnType<MerchantCenterFeedDeps["redis"]>, token: string): Promise<void> {
  try {
    await redis.eval(LOCK_SCRIPT_RELEASE, 1, FEED_LOCK_KEY, token);
  } catch {
    // MerchantCenterFeedRun logs it and moves on.
  }
}

// `Link.maximum(:id)`: the last shard index, nil for an empty table.
async function lastShardIndex(): Promise<bigint | null> {
  const [row] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT MAX(${Prisma.raw("`links`.`id`")}) FROM ${Prisma.raw("`links`")}`);
  const maxId = row ? Object.values(row)[0] : null;
  return maxId === null || maxId === undefined ? null : BigInt(maxId as bigint | number | string) / BigInt(SHARD_WIDTH);
}

async function call(deps: JobDeps, extra: MerchantCenterFeedDeps): Promise<void> {
  if (await extra.killSwitchEngaged(KILL_SWITCH)) return;

  const redis = extra.redis();
  const token = deps.uuid();
  const locked = await redis.set(FEED_LOCK_KEY, token, "EX", LOCK_TTL_SECONDS, "NX");
  if (locked === null) throw new GenerationInProgress("another Merchant Center feed run is in progress");

  try {
    // shard_indexes: both reads happen before either is checked.
    await redis.get(FEED_MAX_SHARD_KEY);
    await lastShardIndex();
    await redis.hkeys(FEED_PROGRESS_KEY);
    // check_in before the first unit to publish.
    if (await extra.killSwitchEngaged(KILL_SWITCH)) throw new KillSwitchEngaged();
    await renewLock(redis, token);
    throw new HandBackToRuby("MerchantCenterFeedService publishes the feed (product scan and S3 upload)");
  } catch (error) {
    if (!(error instanceof KillSwitchEngaged)) throw error;
  } finally {
    await releaseLock(redis, token);
  }
}

const integerArgument = (value: JsonValue | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new HandBackToRuby("an argument that is not an Integer");
};

export const generateMerchantCenterFeedWorkerWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<MerchantCenterFeedDeps> = {},
) =>
  modelJob({ min: 0, max: 2 }, async ([maxProducts, attemptArgument], deps) => {
    const attempt = integerArgument(attemptArgument, 1);
    // max_products goes to the feed service and is echoed to the retry; only an Integer is a value Node has seen.
    const products = integerArgument(maxProducts, DEFAULT_MAX_PRODUCTS);
    try {
      await call(deps, { ...defaultFeedDeps, ...extras });
    } catch (error) {
      if (!(error instanceof GenerationInProgress)) throw error;
      if (attempt >= LOCK_MAX_ATTEMPTS) throw error;
      await performAsync(JOB, [products, attempt + 1], { delaySeconds: LOCK_RETRY_DELAY_SECONDS });
    }
  })(overrides);

export const generateMerchantCenterFeedWorker = generateMerchantCenterFeedWorkerWith();
