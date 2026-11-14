// Port of the lookup of app/sidekiq/regenerate_creator_analytics_cache_worker.rb: a seller that no longer exists raises RecordNotFound, as in
// Rails. For one that does, Rails parses the date and overwrites the seller's analytics cache by date, state and referral
// (CreatorAnalytics::CachingProxy: the analytics queries and the cache table writes), which stays with Rails: the job is handed back right
// after the user read, a date Ruby cannot parse included.
// Golden: __fixtures__/regenerate-creator-analytics-cache-worker.golden.json (scripts/golden/regenerate-creator-analytics-cache-worker.rb);
// the caching proxy and the query timeout were replaced by recorders there.
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const regenerateCreatorAnalyticsCacheWorkerWith = modelJob({ min: 2 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang<User>("User", id);

  throw new HandBackToRuby("CreatorAnalytics::CachingProxy#overwrite_cache is not ported");
});

export const regenerateCreatorAnalyticsCacheWorker = regenerateCreatorAnalyticsCacheWorkerWith();
