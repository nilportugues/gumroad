// Replays save-installment.golden.json (scripts/golden/save-installment.rb): SaveInstallmentService run by the real app inside a
// request-like executor. Node must send the statements Rails sent given the same answers, make the same Elasticsearch requests and
// Redis writes and report the same error. A case Node cannot prove (files, markup Nokogiri rewrites) stops before its first write.
//
// The Redis cases need JOBS_REDIS_URL (a scratch database other than 0) and are skipped without it.
import { readFileSync } from "node:fs";

import type { Installment, User } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson, RubyFloat } from "../jobs/sidekiq/ruby-json.ts";
import { setEsSender, type EsRequest } from "../search/transport.ts";
import { asSidekiqJob, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { setInstallmentRuleDeps } from "./installment-rule-writes.ts";
import { installmentDeps, Installments } from "./installment-writes.ts";
import { saveInstallment } from "./save-installment.ts";
import { findByIdBang } from "./row-reads.ts";

// ObfuscateIds keys the golden was recorded with (scripts/golden/save-installment.rb).
process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws82-golden-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

type EsExchange = { method: string; path: string; query: string | null; body: string | null };
type Case = {
  name: string;
  case_now: unknown;
  es?: EsExchange[];
  es_body?: unknown;
  request_params: Record<string, unknown>;
  installment_id: number | null;
  error: { class: string; message: string } | null;
  return: { ok: boolean; error: string | null; installment_id: number | null } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/save-installment.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

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

// Left to Rails: refused before the first write (the statements Node did send must be a prefix of Rails').
const REFUSED = new Set([
  "create: with a file",
  "create: a message with an upsell card",
  "create: a name that needs transliteration",
  "create: a message with a script",
  "create: a message with unclosed tags",
  "message: upper case tags",
  "message: a self closing br",
  "message: a non breaking space",
  "message: a numeric entity",
  "message: a list of paragraphs",
  "message: an image",
  "message: a link with a space and non ascii",
  "message: a block inside a paragraph",
  "message: a stray closing tag",
  "message: a comment",
  "message: a bare ampersand and angle",
  "message: a tab and a carriage return",
  "message: attributes without values or quotes",
]);

const sequentialUuid = () => {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
};
const withoutJobIds = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const secondsOf = (value: unknown) => (typeof value === "number" ? value : (value as RubyFloat).value);

describe("SaveInstallmentService", () => {
  it("has recorded cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(70);
  });

  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      await redis!.flushdb();
      const nowSeconds = secondsOf(c.case_now);
      const now = () => new Date(Math.round(nowSeconds * 1000));
      const sql = sqlReplay(c.statements);
      const runtime = createJobsRuntime({ sidekiqRedis: redis!, bullmqRedis: redis!, registry: rubyRuntimeRegistry(), now: () => nowSeconds, newJid: sequentialJids() });
      const esSent: EsRequest[] = [];
      const restoreEs = setEsSender(async (request) => {
        esSent.push(request);
        return { status: 200, body: c.es_body ?? {} };
      });
      const restoreRules = setInstallmentRuleDeps({ redis: () => redis!, uuid: sequentialUuid(), notify: () => {} });
      const slugUuid = installmentDeps.uuid;
      installmentDeps.uuid = sequentialUuid();
      let hex = 0;
      let error: unknown = null;
      let result: Awaited<ReturnType<typeof saveInstallment>> | null = null;
      try {
        await asSidekiqJob(
          () =>
            withJobsRuntime(runtime, async () => {
              const seller = await findByIdBang<User>("User", 1n);
              const installment = c.installment_id === null ? null : Installments.load(await findByIdBang<Installment>("Installment", BigInt(c.installment_id)));
              result = await saveInstallment({ seller, params: c.request_params, installment }, { now, hex4: () => (++hex).toString(16).padStart(8, "0"), notify: () => {} });
            }),
          nowSeconds,
        );
      } catch (e) {
        error = e;
      } finally {
        restoreEs();
        restoreRules();
        installmentDeps.uuid = slugUuid;
      }

      if (REFUSED.has(c.name)) {
        expect((error as Error | null)?.name).toBe("NotPortedError");
        const performed = sql.log.filter((statement, index) => !(statement === "ROLLBACK" && index === sql.log.length - 1));
        expect(performed).toEqual(sql.expected.slice(0, performed.length));
        return;
      }

      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      const expected = c.return!;
      expect(result!.error).toEqual(expected.error);
      expect(result!.ok).toEqual(expected.ok);
      expect(esSent.map((request) => ({ method: request.method, path: request.path, query: new URLSearchParams(request.query ?? {}).toString() || null, body: request.body ?? null }))).toEqual(
        (c.es ?? []).map(({ method, path, query, body }) => ({ method, path, query, body })),
      );
      expect(JSON.parse(withoutJobIds(await snapshotRedis(redis!)))).toEqual(JSON.parse(withoutJobIds(c.redis)));
    });
  }
});
