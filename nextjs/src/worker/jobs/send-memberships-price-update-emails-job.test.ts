// Replays send-memberships-price-update-emails-job.golden.json (scripts/golden/send-memberships-price-update-emails-job.rb): the real job
// run by Rails as a Sidekiq job with ActiveJob on the Sidekiq adapter. Node sends the same statements, claim UUIDs and ActiveJob pushes.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { sendMembershipsPriceUpdateEmailsJobWith } from "./send-memberships-price-update-emails-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/send-memberships-price-update-emails-job.golden.json", import.meta.url),
);
const FAILED_PUSH = "an enqueue that fails";

// Rails draws the claim and then the ActiveJob job_id from one SecureRandom.uuid sequence per case.
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const handler = sendMembershipsPriceUpdateEmailsJobWith({ now: () => new Date(Math.round(golden.now * 1000)), uuid });

replayJobGolden(
  "SendMembershipsPriceUpdateEmailsJob",
  { ...golden, cases: golden.cases.filter((c) => c.name !== FAILED_PUSH) },
  async (args, context) => {
    sequence = 0;
    return handler(args, context);
  },
);

function runCase(statements: Statement[], failPush: boolean) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const failing = new Proxy(recording.redis, {
    get(target, property) {
      if (property !== "pipeline" || !failPush) return Reflect.get(target, property);
      return () => {
        const chain = target.pipeline();
        chain.exec = async () => {
          throw new Error("queue is down");
        };
        return chain;
      };
    },
  });
  const runtime = createJobsRuntime({
    sidekiqRedis: failing,
    bullmqRedis: failing,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  sequence = 0;
  const done = asSidekiqJob(() => handler([], contextFor(runtime)), golden.now).then(
    () => null,
    (error: unknown) => error as Error,
  );
  return { sql, recording, done };
}

const caseNamed = (name: string) => golden.cases.find((c) => c.name === name)!;
const lockedRowOf = (s: Statement) => s.sql.includes("FOR UPDATE") && s.result?.rows?.[0] !== undefined;
const withColumn = (s: Statement, name: string, value: unknown): Statement => {
  const at = s.result!.fields!.indexOf(name);
  return {
    ...s,
    result: { ...s.result, rows: [s.result!.rows![0]!.map((v, i) => (i === at ? (value as never) : v))] },
  };
};

// Another writer can change the row between the batch read and the lock: these rows are the locking read's answer, so they follow
// the Ruby source (`with_lock` reloads, then the guards run) rather than a recording.
describe("a plan change another run changed before the lock", () => {
  it("is skipped when the locked row was notified meanwhile", async () => {
    const statements = caseNamed("a plan change due in a week")
      .statements.filter((s) => !s.sql.startsWith("UPDATE"))
      .map((s) =>
        lockedRowOf(s) ? withColumn(s, "notified_subscriber_at", { $time: "2026-11-04T12:00:00.000000Z" }) : s,
      );
    const { sql, recording, done } = runCase(statements, false);

    expect(await done).toBeNull();
    expect(sql.log).toEqual(sql.expected);
    expect(recording.snapshot()).toEqual({});
  });

  it("keeps the other run's claim when a failed push finds it replaced", async () => {
    const statements = caseNamed(FAILED_PUSH).statements;
    const releaseAt = statements.map((s, i) => (lockedRowOf(s) ? i : -1)).filter((i) => i >= 0)[1]!;
    const changed = statements
      .map((s, i) => (i === releaseAt ? withColumn(s, "notification_claim_id", "another-claim") : s))
      .filter((s, i) => !(i === releaseAt + 1 && s.sql.startsWith("UPDATE")));
    const { sql, recording, done } = runCase(changed, true);

    expect((await done)?.message).toBe("queue is down");
    expect(sql.log).toEqual(sql.expected);
    expect(sql.log.filter((s) => s.startsWith("UPDATE"))).toHaveLength(1);
    expect(recording.snapshot()).toEqual({});
  });
});

describe("a push that fails", () => {
  it("releases the claim and raises, as Rails does, leaving the next plan change for the next run", async () => {
    const c = golden.cases.find((candidate) => candidate.name === FAILED_PUSH)!;
    const sql = sqlReplay(c.statements);
    const recording = recordingSidekiqRedis();
    const failing = new Proxy(recording.redis, {
      get(target, property) {
        if (property !== "pipeline") return Reflect.get(target, property);
        return () => {
          const chain = target.pipeline();
          chain.exec = async () => {
            throw new Error("queue is down");
          };
          return chain;
        };
      },
    });
    const runtime = createJobsRuntime({
      sidekiqRedis: failing,
      bullmqRedis: failing,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    sequence = 0;
    let error: unknown = null;
    try {
      await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
    } catch (e) {
      error = e;
    }

    expect((error as Error).message).toBe(c.error!.message);
    expect(sql.log).toEqual(sql.expected);
    expect(recording.snapshot()).toEqual({});
  });
});
