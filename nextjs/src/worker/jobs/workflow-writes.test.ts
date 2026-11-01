// Replays workflow-writes.golden.json (scripts/golden/workflow-writes.rb): Workflow#publish!, #unpublish! and #mark_deleted!
// run by the real app, with the InstallmentRule#advance_version! and Installment writes they make. Node must send the
// statements Rails sent, given the same answers, make the same Elasticsearch requests and Redis writes, queue the same Sidekiq
// payloads and fail with the same errors. A case Node refuses (an email with files) stops before the first write.
//
// The Redis cases need JOBS_REDIS_URL (a scratch database other than 0) and are skipped without it.
import { readFileSync } from "node:fs";

import type { Workflow } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { withJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import { setInstallmentRuleDeps } from "../../server/models/installment-rule-writes.ts";
import { findByIdBang } from "../../server/models/row-reads.ts";
import { markDeletedBang, publishBang, unpublishBang, Workflows } from "../../server/models/workflow-writes.ts";
import { setEsSender, type EsRequest } from "../../server/search/transport.ts";
import { asSidekiqJob, contextFor, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";

type EsExchange = { method: string; path: string; query: string | null; body: string | null };
type Case = {
  name: string;
  kind: "publish!" | "unpublish!" | "mark_deleted!";
  case_now: unknown;
  es?: EsExchange[];
  es_body?: unknown;
  error: { class: string; message: string } | null;
  return: unknown;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/workflow-writes.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
beforeAll(() => {
  if (url) redis = new Redis(url);
});
afterAll(async () => {
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});

// What installment-writes.ts and its callers leave to Rails, refused before the first write.
const REFUSED = new Set(["publish!: an email with a file"]);

const sequentialUuid = () => {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
};
const withoutJobIds = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const secondsOf = (value: unknown) => (typeof value === "number" ? value : (value as RubyFloat).value);

describe("Workflow writes", () => {
  it("has recorded cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      await redis!.flushdb();
      const nowSeconds = secondsOf(c.case_now);
      const now = () => new Date(Math.round(nowSeconds * 1000));
      const uuid = sequentialUuid();
      const sql = sqlReplay(c.statements);
      const runtime = createJobsRuntime({ sidekiqRedis: redis!, bullmqRedis: redis!, registry: rubyRuntimeRegistry(), now: () => nowSeconds, newJid: sequentialJids() });
      const esSent: EsRequest[] = [];
      const restoreEs = setEsSender(async (request) => {
        esSent.push(request);
        return { status: 200, body: c.es_body ?? {} };
      });
      const restoreRules = setInstallmentRuleDeps({ redis: () => redis!, uuid, notify: () => {} });
      let error: unknown = null;
      let returned: unknown = null;
      try {
        await asSidekiqJob(
          () =>
            withJobsRuntime(runtime, async () => {
              const workflow = Workflows.load(await findByIdBang<Workflow>("Workflow", 1n));
              if (c.kind === "publish!") returned = await publishBang(workflow, { now, uuid, logError: () => {} });
              else if (c.kind === "unpublish!") returned = await unpublishBang(workflow, { now });
              else returned = await markDeletedBang(workflow, { now });
            }),
          nowSeconds,
        );
      } catch (e) {
        error = e;
      } finally {
        restoreEs();
        restoreRules();
      }

      if (REFUSED.has(c.name)) {
        expect((error as Error | null)?.name).toBe("NotPortedError");
        const performed = sql.log.filter((statement, index) => !(statement === "ROLLBACK" && index === sql.log.length - 1));
        expect(performed).toEqual(sql.expected.slice(0, performed.length));
        return;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(esSent.map((request) => ({ method: request.method, path: request.path, query: new URLSearchParams(request.query ?? {}).toString() || null, body: request.body ?? null }))).toEqual(
        (c.es ?? []).map(({ method, path, query, body }) => ({ method, path, query, body })),
      );
      if (error === null) expect(returned).toEqual(c.return);
      expect(JSON.parse(withoutJobIds(await snapshotRedis(redis!)))).toEqual(JSON.parse(withoutJobIds(c.redis)));
    });
  }
});

export type { JsonValue };
