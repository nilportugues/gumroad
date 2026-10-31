// Replays link-writes.golden.json (scripts/golden/link-writes.rb): `Link.find(id).update(banned_at:)`
// run by the real Link model against MySQL. Node must send the statements Rails sent, given the same
// answers, and make the same Elasticsearch requests, cache deletes and Redis writes.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { esRecorder, fakeSidekiqRedis } from "../search/__fixtures__/job-harness.ts";
import { rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { bannedAtValue, findLinkBang, Links, resetLinkCollaborators, setLinkCollaborators } from "./link.ts";
import type { Errors } from "./runtime/errors.ts";

type EsRequest = { method: string; path: string; query: string | null; body: string | null };
type LinkWritesCase = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  cache: [string, string][];
  es: EsRequest[];
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/link-writes.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  cases: LinkWritesCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));

// The Ruby side raises with `errors.map { [attribute, raw_type] }.inspect` when update returns false.
export function rubyErrorsInspect(errors: Errors): string {
  return `[${errors.details.map((d) => `[${JSON.stringify(d.attribute)}, ${JSON.stringify(d.type ?? d.message)}]`).join(", ")}]`;
}

// A $redis holding the case's starting strings; Flipper gates are read from the same snapshot.
export function fakeMainRedis(before: RedisSnapshot = {}) {
  const snapshot = structuredClone(before) as Record<string, { type: string; value: unknown; expires: boolean }>;
  const redis = {
    async get(key: string) {
      const entry = snapshot[key];
      return entry?.type === "string" ? (entry.value as string) : null;
    },
    async incr(key: string) {
      const value = Number(snapshot[key]?.value ?? 0) + 1;
      snapshot[key] = { type: "string", value: String(value), expires: false };
      return value;
    },
  };
  const features = (snapshot.flipper_features?.value as string[] | undefined) ?? [];
  const isFeatureEnabled = async (name: string) => features.includes(name) && (snapshot[name]?.value as Record<string, string>).boolean === "true";
  const sorted = () => Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { redis, isFeatureEnabled, snapshot: sorted };
}

afterEach(() => resetLinkCollaborators());

describe("Link writes", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const es = esRecorder();
      const sidekiq = fakeSidekiqRedis();
      const main = fakeMainRedis(c.redis_before);
      const cache: [string, string][] = [];
      setLinkCollaborators({ redis: () => main.redis as never, isFeatureEnabled: main.isFeatureEnabled, cacheDelete: async (name) => void cache.push(["cache_delete", name]) });
      const runtime = createJobsRuntime({ sidekiqRedis: sidekiq.redis, bullmqRedis: sidekiq.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      let error: unknown = null;
      try {
        await withJobsRuntime(runtime, async () => {
          const link = await findLinkBang(9);
          const bannedAt = c.name === "unbanning a product" ? null : bannedAtValue(now());
          if (!(await Links.update(link, { banned_at: bannedAt }, { now }))) throw new Error(`update returned false: ${rubyErrorsInspect(link.errors)}`);
        });
      } catch (e) {
        error = e;
      } finally {
        es.restore();
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(es.requests).toEqual(c.es);
      expect(cache).toEqual(c.cache);
      expect({ ...main.snapshot(), ...sidekiq.snapshot() }).toEqual(c.redis);
    });
  }
});
