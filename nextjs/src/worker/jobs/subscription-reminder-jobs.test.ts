// Replays subscription-reminder-jobs.golden.json (scripts/golden/subscription-reminder-jobs.rb): each
// job run by the real app against MySQL as a Sidekiq job, at its own frozen time. Node must send the
// statements Rails sent, given the same answers, queue the same Sidekiq payloads and fail with the
// same errors. Cases Node hands back stop at the last statement it can decide on, which must be a
// prefix of Rails' statements, with nothing pushed.
// The `price:` cases run Subscription#current_subscription_price_cents on its own (Ws48PriceProbe in
// the script) and also pin the cents it answered.
// Cases that push a unique job need JOBS_REDIS_URL (a scratch database) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { evaluateFeature, parseGateValues } from "../../server/infra/flipper.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setPurchasingPowerParityDepsForTesting } from "../../server/models/purchasing-power-parity.ts";
import { mailerKeyDigest } from "../../server/models/sent-email-info.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { defaultSubscriptionDeps, SubscriptionRecord } from "../../server/models/subscription.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  chargeDeclinedReminderWorkerWith,
  findSubscriptionsWithMissingChargeWorkerWith,
  freeTrialExpiringReminderWorkerWith,
  recurringChargeReminderWorkerWith,
  reviewReminderJobWith,
  sendAutoInvoiceEmailJobWith,
} from "./subscription-reminder-jobs.ts";
import type { JobHandler } from "./types.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  case_now: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
  eligibility_statements?: number;
  // The commands the PurchasingPowerParityService sent to the `ppp` Redis namespace.
  ppp_commands?: string[][];
  // The cents a `price:` case answered.
  result?: number | null;
  // Node cannot price the case (it hands the job back to Rails).
  hand_back?: boolean;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/subscription-reminder-jobs.golden.json", import.meta.url), "utf8")) as unknown as {
  digests: [JsonValue[], string][];
  cases: Case[];
};

// The Flipper documents the case started from, as `hgetall` returns them.
function featureActive(before: RedisSnapshot) {
  return async (name: string, actor: string | { flipperId: string } | null) => {
    const doc = (before[name]?.value ?? {}) as Record<string, string>;
    return evaluateFeature(name, parseGateValues(doc), actor);
  };
}

const caseNow = (c: Case) => (typeof c.case_now === "number" ? c.case_now : c.case_now.value);

let probeResult: number | null | undefined;

const handlers = (c: Case): Record<string, JobHandler> => {
  const now = () => new Date(Math.round(caseNow(c) * 1000));
  const extras = { featureActive: featureActive(c.redis_before) };
  return {
    Ws48PriceProbe: async (args) => {
      const subscription = await findByIdBang<Record<string, unknown>>("Subscription", recordIdFrom(args[0], "Subscription.find"));
      // A price Node cannot work out hands the job back, as the sweep does.
      probeResult = await beforeSideEffects(() => new SubscriptionRecord(subscription as never, { now, featureActive: extras.featureActive ?? defaultSubscriptionDeps.featureActive }).currentSubscriptionPriceCents());
    },
    FreeTrialExpiringReminderWorker: freeTrialExpiringReminderWorkerWith({ now }, extras),
    ChargeDeclinedReminderWorker: chargeDeclinedReminderWorkerWith({ now }, extras),
    RecurringChargeReminderWorker: recurringChargeReminderWorkerWith({ now }, extras),
    ReviewReminderJob: reviewReminderJobWith({ now }),
    SendAutoInvoiceEmailJob: sendAutoInvoiceEmailJobWith({ now }),
    FindSubscriptionsWithMissingChargeWorker: findSubscriptionsWithMissingChargeWorkerWith({ now }, extras),
  };
};

// CustomerMailer.auto_invoice is delivered inline by Rails, and a purchasing-power-parity price needs
// the country factors.
const handsBack = (c: Case) => (c.eligibility_statements !== undefined && c.statements.length > c.eligibility_statements) || c.hand_back === true;

const withoutJobIds = (value: unknown) => JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const takesLocks = (redis: RedisSnapshot) => Object.keys(redis).some((key) => key.startsWith("uniquejobs"));
// What the case's own writes left, without the Flipper documents `setup:` put there.
const withoutSetup = (redis: RedisSnapshot, before: RedisSnapshot) => Object.fromEntries(Object.entries(redis).filter(([key, entry]) => JSON.stringify(before[key]) !== JSON.stringify(entry)));

// The `ppp` keys the case started with, served and logged the way the service's Redis commands are: a
// list at the key fails a GET with WRONGTYPE.
function pppRedis(before: RedisSnapshot) {
  const commands: string[][] = [];
  return {
    commands,
    redis: {
      async get(key: string) {
        commands.push(["get", key]);
        const entry = before[key];
        if (entry === undefined) return null;
        if (entry.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return entry.value as string;
      },
    },
  };
}
afterEach(() => setPurchasingPowerParityDepsForTesting(undefined));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

describe("mailer key digests", () => {
  for (const [args, digest] of golden.digests) {
    it(`SentEmailInfo.mailer_key_digest(${JSON.stringify(args)})`, () => {
      const [mailer, method, ...rest] = args as [string, string, ...(number | string)[]];
      expect(mailerKeyDigest(mailer, method, ...rest)).toBe(digest);
    });
  }
});

describe("subscription reminder jobs", () => {
  for (const c of golden.cases) {
    it.skipIf(takesLocks(c.redis) && !url)(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.statements);
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (takesLocks(c.redis)) {
        await realRedis!.flushdb();
        sidekiqRedis = realRedis!;
        snapshot = () => snapshotRedis(realRedis!);
      } else {
        const recording = recordingSidekiqRedis();
        sidekiqRedis = recording.redis;
        snapshot = async () => recording.snapshot();
      }
      const runtime = createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry: rubyRuntimeRegistry(), now: () => caseNow(c), newJid: sequentialJids() });
      let error: unknown = null;
      probeResult = undefined;
      const ppp = pppRedis(c.redis_before);
      setPurchasingPowerParityDepsForTesting({ redis: () => ppp.redis as never });
      try {
        await asSidekiqJob(() => handlers(c)[c.job]!(c.args, contextFor(runtime)), caseNow(c));
      } catch (e) {
        error = e;
      }

      if (handsBack(c)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
        if (c.eligibility_statements !== undefined) expect(sql.log.length).toBe(c.eligibility_statements);
        expect(await snapshot()).toEqual({});
        return;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(ppp.commands).toEqual(c.ppp_commands ?? []);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      if (c.job === "Ws48PriceProbe" && c.error === null) expect(probeResult).toEqual(c.result);
      expect(JSON.parse(withoutJobIds(await snapshot()))).toEqual(JSON.parse(withoutJobIds(withoutSetup(c.redis, c.redis_before))));
    });
  }
});
