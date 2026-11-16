// Replays utm-link-sale-attribution-job.golden.json (scripts/golden/utm-link-sale-attribution-job.rb): UtmLinkSaleAttributionJob run
// by the real app as a Sidekiq job. Node sends the statements Rails sent, in order: the order's successful purchases, each purchase
// second's latest visits per link, then per claimed purchase the visit's country update and the `utm_link_driven_sales` insert.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { utmLinkSaleAttributionJobWith } from "./utm-link-sale-attribution-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/utm-link-sale-attribution-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = utmLinkSaleAttributionJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

describe("UtmLinkSaleAttributionJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
