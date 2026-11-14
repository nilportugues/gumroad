// Replays update-tax-rates-job.golden.json (scripts/golden/update-tax-rates-job.rb): UpdateTaxRatesJob run by the real app as a Sidekiq job,
// TaxJar's /v2/summary_rates answered by WebMock. Node sends the same GET (URL, headers) and the statements Rails sent (the lookups,
// then each insert or update in its transaction), pushes the same InternalNotificationWorker items and fails with the same Taxjar error.
// An answer Ruby fails on in the middle of its writes (a qualifying entry without a numeric rate, or one that is a string) and a rate
// outside what the column holds are handed back before the first write.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { updateTaxRatesJobWith } from "./update-tax-rates-job.ts";

type Answer = { status?: number; body?: string };
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  http: { method: string; url: string; headers: Record<string, string> }[];
  http_responses: Answer[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/update-tax-rates-job.golden.json", import.meta.url), "utf8"),
) as unknown as {
  now: number;
  cases: Case[];
};

// Ruby fails on these in the middle of the writes (or not at all, when nothing qualifies before them); Node reads them first.
const HANDED_BACK = new Set(["a rate given as a string", "a rate without an average rate", "an average rate of null"]);
// Taxjar errors carry their Ruby class; the other failure Ruby raises is a plain Taxjar::Error.
const platform = (agent: string) => agent.replace(/\(.*\)/u, "(<platform>)");

type Seen = { url: string; method: string; headers: Record<string, string> };

async function run(c: Case, statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const seen: Seen[] = [];
  const answers = [...c.http_responses];
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const answer = answers.shift() ?? {};
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    seen.push({ url: String(input), method: init?.method ?? "GET", headers });
    return Promise.resolve(new Response(answer.body ?? "{}", { status: answer.status ?? 200 }));
  }) as typeof fetch;
  const handler = updateTaxRatesJobWith({ now: () => new Date(Math.round(golden.now * 1000)), fetch: fakeFetch });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, seen, error };
}

describe("UpdateTaxRatesJob", () => {
  beforeEach(() => {
    vi.stubEnv("RAILS_ENV", "test");
    vi.stubEnv("TAXJAR_ENDPOINT", "");
    vi.stubEnv("TAXJAR_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { sql, recording, seen, error } = await run(c, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      if (c.error?.class.startsWith("Taxjar::Error")) expect(error?.name).toBe(c.error.class);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual(c.redis);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.method).toBe(c.http[0]!.method);
      expect(new URL(seen[0]!.url).pathname).toBe(new URL(c.http[0]!.url).pathname);
      expect(new URL(seen[0]!.url).hostname).toBe(new URL(c.http[0]!.url).hostname);
      const sent = seen[0]!.headers;
      const recorded = c.http[0]!.headers;
      expect(sent.authorization).toBe(recorded.Authorization);
      expect(sent["x-api-version"]).toBe(recorded["X-Api-Version"]);
      expect(platform(sent["user-agent"]!)).toBe(recorded["User-Agent"]);
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, recording, error } = await run(c, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands an answer that is JSON but not an object back", async () => {
    const { sql, error } = await run({ ...golden.cases[0]!, http_responses: [{ body: "[]" }] }, []);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
  });

  it("hands a rate the decimal(8, 7) column cannot hold back before any statement", async () => {
    const body = JSON.stringify({ summary_rates: [{ country_code: "FR", average_rate: { rate: 12.5 } }] });
    const { sql, error } = await run({ ...golden.cases[0]!, http_responses: [{ body }] }, []);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
  });

  it("hands a later entry without a rate back before the first write", async () => {
    const body = JSON.stringify({
      summary_rates: [{ country_code: "FR", average_rate: { rate: 0.2 } }, { country_code: "DE" }],
    });
    const { sql, recording, error } = await run({ ...golden.cases[0]!, http_responses: [{ body }] }, []);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
    expect(recording.snapshot()).toEqual({});
  });

  it("rejects an argument, as perform takes none", async () => {
    const handler = updateTaxRatesJobWith();
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
    });

    await expect(handler([1], contextFor(runtime))).rejects.toThrow("wrong number of arguments");
  });
});
