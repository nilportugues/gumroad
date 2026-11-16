// Replays audience-member-filter.golden.json (scripts/golden/audience-member-filter.rb): Installment#audience_members_filter_params
// run by the real app (statements and the params it returns), and ActiveSupport's Date#in_time_zone for every zone a seller can pick.
import { readFileSync } from "node:fs";

import type { Installment } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asSidekiqJob } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { audienceMembersFilterParams } from "./installment-audience.ts";
import { InstallmentPost } from "./installment-post.ts";
import { endOfDayIso8601, startOfDayIso8601 } from "./concerns/rails-time-zone.ts";
import { findById } from "./row-reads.ts";

type ParamsCase = { name: string; error: { class: string; message: string } | null; statements: Statement[]; return: unknown };
type Zone = { name: string; tzinfo: string; dates: Record<string, { start: string; end: string }> };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/audience-member-filter.golden.json", import.meta.url), "utf8")) as { filter_params_cases: ParamsCase[]; zones: Zone[] };

const NOW_SECONDS = 1_762_000_245;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  // The keys scripts/golden/audience-member-filter.rb ran with
  for (const [key, value] of Object.entries({ OBFUSCATE_IDS_CIPHER_KEY: "ws63-golden-obfuscate-key", OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "123456789" })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Cases whose stored filter Node does not read, with the reason: it throws NotPortedError before it guesses.
const NOT_PORTED = new Set([
  "bought variant that does not decode",
  "paid more than as a string",
  "created after that is not a date",
  "created after with a six digit year",
  "created after as a number",
  "not clicked post that does not exist",
]);

describe("Installment#audience_members_filter_params", () => {
  for (const c of golden.filter_params_cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      let result: unknown = null;
      let error: Error | null = null;
      try {
        // As a Sidekiq job runs it: inside the executor, so equal reads share the query cache.
        result = await asSidekiqJob(async () => {
          const row = (await findById<Installment>("Installment", 10n))!;
          return audienceMembersFilterParams(new InstallmentPost(row));
        }, NOW_SECONDS);
      } catch (e) {
        error = e as Error;
      }
      if (NOT_PORTED.has(c.name)) {
        expect(error?.name).toBe("NotPortedError");
        expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
        return;
      }
      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      if (c.error === null) expect(JSON.parse(JSON.stringify(result))).toEqual(c.return);
    });
  }
});

describe("Date#in_time_zone", () => {
  it("covers every zone", () => {
    expect(golden.zones.length).toBeGreaterThan(100);
  });

  for (const zone of golden.zones) {
    it(`${zone.name} (${zone.tzinfo})`, () => {
      for (const [date, expected] of Object.entries(zone.dates)) {
        const [year, month, day] = date.split("-").map(Number) as [number, number, number];
        expect([date, startOfDayIso8601(zone.name, year, month, day)]).toEqual([date, expected.start]);
        expect([date, endOfDayIso8601(zone.name, year, month, day)]).toEqual([date, expected.end]);
      }
    });
  }
});
