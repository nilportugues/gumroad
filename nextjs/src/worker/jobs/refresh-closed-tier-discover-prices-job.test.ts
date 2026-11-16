// Replays refresh-closed-tier-discover-prices-job.golden.json (scripts/golden/refresh-closed-tier-discover-prices-job.rb):
// RefreshClosedTierDiscoverPricesJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the batch query,
// each product's touch with its PaperTrail version, the re-read behind the index update) and the same Elasticsearch request.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../../server/models/link.ts";
import { esRecorder, fakeSidekiqRedis } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { refreshClosedTierDiscoverPricesJobWith } from "./refresh-closed-tier-discover-prices-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
  es: { method: string; path: string; query: string | null; body: string | null }[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/refresh-closed-tier-discover-prices-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = refreshClosedTierDiscoverPricesJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

afterEach(() => resetLinkCollaborators());

describe("RefreshClosedTierDiscoverPricesJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const es = esRecorder();
      const sidekiq = fakeSidekiqRedis();
      const cache: [string, string][] = [];
      setLinkCollaborators({
        isFeatureEnabled: () => Promise.resolve(false),
        cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])),
      });
      const runtime = createJobsRuntime({
        sidekiqRedis: sidekiq.redis,
        bullmqRedis: sidekiq.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      } finally {
        es.restore();
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(cache).toEqual(c.cache);
      expect(sidekiq.snapshot()).toEqual(c.redis);
    });
  }
});
