// Replays user-balance-stats.golden.json (scripts/golden/user-balance-stats.rb): UserBalanceStatsService#overview_stats run by
// the real app. Node sends the statement and the six Elasticsearch requests Rails sent (the three sales totals, each a
// seller search and an affiliate search, the cutoffs frozen to the golden clock) and computes the same figures.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { setEsSender, type EsRequest } from "../search/transport.ts";
import { asSidekiqJob } from "../../worker/jobs/__fixtures__/golden.ts";
import { balanceStatsCacheKey, BALANCE_STATS_CACHE_TTL_SECONDS, overviewStats } from "./user-balance-stats.ts";

type EsExchange = { method: string; path: string; query: string | null; body: string | null };
type Case = { name: string; error: { class: string; message: string } | null; return: unknown; statements: Statement[]; es: EsExchange[]; es_body: unknown };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/user-balance-stats.golden.json", import.meta.url), "utf8")) as { now: number; cases: Case[] };
const now = new Date(Math.round(golden.now * 1000));

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("UserBalanceStatsService#overview_stats", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      // The first recorded statement is the test's own `User.find`.
      const sql = sqlReplay(c.statements.slice(1));
      const sent: EsRequest[] = [];
      restore = setEsSender(async (request) => {
        sent.push(request);
        return { status: 200, body: c.es_body ?? {} };
      });
      let error: unknown = null;
      let result: unknown = null;
      try {
        result = await asSidekiqJob(() => overviewStats(1n, now), golden.now);
      } catch (e) {
        error = e;
      }
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(sent.map((request) => ({ method: request.method, path: request.path, query: new URLSearchParams(request.query ?? {}).toString() || null, body: request.body ?? null }))).toEqual(
        c.es.map(({ method, path, query, body }) => ({ method, path, query, body })),
      );
      if (error === null) expect(result).toEqual(c.return);
    });
  }

  it("keys the cache by user and keeps it for 48 hours", () => {
    expect(balanceStatsCacheKey(42n)).toBe("balance_stats_for_user_42_v2");
    expect(BALANCE_STATS_CACHE_TTL_SECONDS).toBe(172_800);
  });
});
