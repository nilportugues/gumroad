// Replays purge-old-deleted-asset-previews-worker.golden.json (scripts/golden/purge-old-deleted-asset-previews-worker.rb):
// PurgeOldDeletedAssetPreviewsWorker run by the real app as a Sidekiq job. Node sends the statements Rails sent (the batch query,
// each preview's attachment, delete and product touch, the cache invalidation, the blob read), makes the same cache deletes and
// pushes the same ActiveStorage::PurgeJob items.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../../server/models/link.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { purgeOldDeletedAssetPreviewsWorkerWith } from "./purge-old-deleted-asset-previews-worker.ts";

type Case = {
  name: string;
  args: never[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/purge-old-deleted-asset-previews-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

afterEach(() => resetLinkCollaborators());

describe("PurgeOldDeletedAssetPreviewsWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const cache: [string, string][] = [];
      setLinkCollaborators({ cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])) });
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let uuids = 0;
      let lagChecks = 0;
      const handler = purgeOldDeletedAssetPreviewsWorkerWith({
        now: () => new Date(Math.round(golden.now * 1000)),
        uuid: () => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, "0")}`,
        watchReplicaLag: () => Promise.resolve(void (lagChecks += 1)),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(cache).toEqual(c.cache);
      expect(recording.snapshot()).toEqual(c.redis);
      // One check before each batch that has something to destroy.
      expect(lagChecks).toBe(
        sql.log.filter((statement) => statement.startsWith("SELECT `asset_previews`.*")).length - (c.error ? 0 : 1),
      );
    });
  }
});
