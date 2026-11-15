// Port of app/sidekiq/regenerate_creator_analytics_cache_worker.rb: overwrites a seller's cached analytics day by date, state and
// referral (CreatorAnalytics::CachingProxy#overwrite_cache) inside a 20 minute `timeoutQueries`. A seller that no longer exists raises
// RecordNotFound, as in Rails. Ruby's Date.parse accepts many formats and raises on others: the port takes `YYYY-MM-DD` only and hands any
// other string back to Rails right after the user read, before a query or a write.
// Golden: __fixtures__/regenerate-creator-analytics-cache-worker.golden.json (scripts/golden/regenerate-creator-analytics-cache-worker.rb).
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { timeoutQueries } from "../../server/models/runtime/max-execution-time.ts";
import { CreatorAnalyticsCachingProxy } from "../../server/page-props/analytics/caching-proxy.ts";
import { addDays } from "../../server/search/civil-time.ts";

import { modelJob } from "./support/job-deps.ts";

// 20.minutes
const QUERY_TIME_BUDGET = 20 * 60;
const ANALYTICS_TYPES = ["date", "state", "referral"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// A string `Date.parse` reads the same way a calendar does: shaped like an ISO date and a day that exists.
const isoDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && addDays(value, 0) === value;
};

export const regenerateCreatorAnalyticsCacheWorkerWith = modelJob({ min: 2 }, async ([userId, dateString], deps) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  const user = await findByIdBang<User>("User", id);
  if (!isoDate(dateString)) throw new HandBackToRuby("a date string Ruby's Date.parse reads");

  const service = new CreatorAnalyticsCachingProxy(user, deps.now);
  await timeoutQueries(QUERY_TIME_BUDGET, async () => {
    for (const type of ANALYTICS_TYPES) await service.overwriteCache(dateString, type);
  });
});

export const regenerateCreatorAnalyticsCacheWorker = regenerateCreatorAnalyticsCacheWorkerWith();
