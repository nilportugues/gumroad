// Port of app/sidekiq/elasticsearch_indexer_worker.rb; the body is src/server/search/indexer.ts.
import { isFeatureEnabled } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { withJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { type IndexerDeps, performIndexer } from "../../server/search/indexer.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

export const defaultIndexerDeps: IndexerDeps = {
  featureActive: (name) => isFeatureEnabled(name),
  smembers: (key) => getRedis("main").smembers(key),
  rand: (max) => Math.floor(Math.random() * max),
  sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};

export function elasticsearchIndexerWorkerWith(overrides: Partial<IndexerDeps> = {}): JobHandler {
  const deps = { ...defaultIndexerDeps, ...overrides };
  return async (args, context) => {
    checkArity(args, 2);
    const params = args[1] as Record<string, JsonValue>;
    await withJobsRuntime(context.runtime, () => performIndexer(args[0]!, params, deps));
  };
}

export const elasticsearchIndexerWorker = elasticsearchIndexerWorkerWith();
