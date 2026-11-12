// Ports of app/sidekiq/refresh_sitemap_daily_worker.rb, refresh_wishlist_sitemap_daily_worker.rb and the categories retry of
// refresh_sitemap_monthly_worker.rb, up to SitemapService's generation lock. A run that finds the lock held comes back later (Rails'
// `GenerationInProgress` rescue); a run that would win it writes the sitemap through SitemapGenerator and S3, which Node does not
// do, so it is handed back before taking the lock. Only the read of the lock differs from Rails (SET NX), so a lock released between
// the read and the hand-back costs a run that Rails would have made at once.
// The monthly worker's first step enqueues the product sitemaps before it reaches the categories, and is handed back whole.
// Golden: __fixtures__/sitemap-workers.golden.json (scripts/golden/sitemap-workers.rb).
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { performAsync, withJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import { toCalendarDate, dateToS } from "../../server/models/concerns/ruby-time.ts";

import { checkArity } from "./arity.ts";
import { type JobDeps, defaultJobDeps } from "./support/job-deps.ts";
import type { JobHandler } from "./types.ts";

// RedisKey.sitemap_generation_lock
const GENERATION_LOCK_KEY = "sitemap_generation_lock";
// SitemapService::GENERATION_RETRY_DELAY
const GENERATION_RETRY_DELAY_SECONDS = 15 * 60;
// RefreshSitemapMonthlyWorker
const CATEGORIES_ONLY = "categories_only";
const CATEGORIES_MAX_ATTEMPTS = 24;

export type SitemapRedis = { get(key: string): Promise<string | null> };
export type SitemapDeps = { redis: () => SitemapRedis };

const lockHeld = (sitemap: Partial<SitemapDeps>) =>
  (sitemap.redis ?? (() => getRedis("main")))()
    .get(GENERATION_LOCK_KEY)
    .then((token) => token !== null);

function handBackWinningRun(): never {
  throw new HandBackToRuby("a sitemap generation that wins the lock writes the sitemap");
}

export const refreshSitemapDailyWorkerWith = (
  overrides: Partial<JobDeps> = {},
  sitemap: Partial<SitemapDeps> = {},
): JobHandler => {
  const deps = { ...defaultJobDeps, ...overrides };
  return (args, context) =>
    withJobsRuntime(context.runtime, async () => {
      checkArity(args, 0, 1);
      if (!(await lockHeld(sitemap))) handBackWinningRun();
      // `def perform(date = Date.current.to_s)`
      const date: JsonValue = args.length > 0 ? args[0]! : dateToS(toCalendarDate(deps.now()));
      await performAsync("RefreshSitemapDailyWorker", [date], { delaySeconds: GENERATION_RETRY_DELAY_SECONDS });
    });
};

export const refreshWishlistSitemapDailyWorkerWith =
  (sitemap: Partial<SitemapDeps> = {}): JobHandler =>
  (args, context) =>
    withJobsRuntime(context.runtime, async () => {
      checkArity(args, 0);
      if (!(await lockHeld(sitemap))) handBackWinningRun();
      await performAsync("RefreshWishlistSitemapDailyWorker", [], { delaySeconds: GENERATION_RETRY_DELAY_SECONDS });
    });

export const refreshSitemapMonthlyWorkerWith =
  (sitemap: Partial<SitemapDeps> = {}): JobHandler =>
  (args, context) =>
    withJobsRuntime(context.runtime, async () => {
      checkArity(args, 0, 2);
      const [step = null, attempt = 1] = args;
      if (step !== CATEGORIES_ONLY) throw new HandBackToRuby("the monthly step that enqueues the product sitemaps");
      if (typeof attempt !== "number" || !Number.isInteger(attempt))
        throw new HandBackToRuby("a sitemap attempt that is not an Integer");
      if (!(await lockHeld(sitemap))) handBackWinningRun();
      // Past the last attempt Rails logs and gives up; the log line is not a state anyone reads.
      if (attempt < CATEGORIES_MAX_ATTEMPTS)
        await performAsync("RefreshSitemapMonthlyWorker", [CATEGORIES_ONLY, attempt + 1], {
          delaySeconds: GENERATION_RETRY_DELAY_SECONDS,
        });
    });

export const refreshSitemapDailyWorker = refreshSitemapDailyWorkerWith();
export const refreshWishlistSitemapDailyWorker = refreshWishlistSitemapDailyWorkerWith();
export const refreshSitemapMonthlyWorker = refreshSitemapMonthlyWorkerWith();
