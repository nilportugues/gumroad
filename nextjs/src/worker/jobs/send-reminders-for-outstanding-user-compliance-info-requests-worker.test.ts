// Replays send-reminders-for-outstanding-user-compliance-info-requests-worker.golden.json
// (scripts/golden/send-reminders-for-outstanding-user-compliance-info-requests-worker.rb): the real worker run by Rails as a Sidekiq job
// with `Stripe::Account.retrieve` replaced by a marker. Node sends the same statements and mail jobs, in the same order.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { sendRemindersForOutstandingUserComplianceInfoRequestsWorkerWith } from "./send-reminders-for-outstanding-user-compliance-info-requests-worker.ts";

const golden = loadGolden(
  new URL(
    "./__fixtures__/send-reminders-for-outstanding-user-compliance-info-requests-worker.golden.json",
    import.meta.url,
  ),
);
const handler = sendRemindersForOutstandingUserComplianceInfoRequestsWorkerWith({
  now: () => new Date(Math.round(golden.now * 1000)),
});

// Rails asks Stripe at the rejected seller, after the sellers before it were reminded; that case is below.
const AFTER_A_REMINDER = "a rejected Stripe account after a seller that was emailed";
replayJobGolden(
  "SendRemindersForOutstandingUserComplianceInfoRequestsWorker",
  { ...golden, cases: golden.cases.filter((c) => c.name !== AFTER_A_REMINDER) },
  handler,
);

async function run(c: JobCase, statements = c.statements) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  let error: unknown = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e;
  }
  return { sql, recording, error: error as Error | null };
}

const caseNamed = (name: string) => golden.cases.find((c) => c.name === name)!;

describe("a rejected Stripe account after a seller that was reminded", () => {
  it("hands back at that seller after sending what Rails sent for the sellers before it", async () => {
    const c = caseNamed(AFTER_A_REMINDER);
    const { sql, recording, error } = await run(c);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(recording.snapshot()).toEqual(
      expect.objectContaining({ "queue:critical": expect.objectContaining({ type: "list" }) }),
    );
    expect(JSON.stringify(recording.snapshot())).toContain('\\"args\\":[1]');
    expect(JSON.stringify(recording.snapshot())).not.toContain('\\"args\\":[2]');
  });
});

// The statements of a case with the stored json_data of its request rows replaced, as if the column held data Ruby reads in a way
// Node does not reproduce.
function withRequestJson(c: JobCase, json: string): JobCase {
  const statements = c.statements.map((s) => {
    if (!/^SELECT `user_compliance_info_requests`\.\* /u.test(s.sql) || !s.result?.rows) return s;
    const at = s.result.fields!.indexOf("json_data");
    return {
      ...s,
      result: { ...s.result, rows: s.result.rows.map((row) => row.map((v, i) => (i === at ? json : v))) },
    };
  });
  return { ...c, statements };
}

describe("stored times Node does not parse", () => {
  it.each([
    ["an emails_sent_at that is not a list", '{"emails_sent_at":"yesterday"}'],
    ["an emails_sent_at holding a time in another format", '{"emails_sent_at":["Nov 2 2026"]}'],
    ["an emails_sent_at holding a number", '{"emails_sent_at":[1]}'],
    ["a json_data that is not a hash", "[1]"],
  ])("hands %s back before it sends or writes anything", async (_name, json) => {
    const { sql, recording, error } = await run(withRequestJson(caseNamed("a request never emailed"), json));

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
    expect(sql.log.some((s) => /^(UPDATE|BEGIN)/u.test(s))).toBe(false);
    expect(recording.snapshot()).toEqual({});
  });
});

describe("a request changed by another writer between the read and the save", () => {
  it("lays emails_sent_at over the json_data the locking read returns, keeping the other keys", async () => {
    const c = caseNamed("a request never emailed");
    const stored = '{"verification_error":{"code":"x"}}';
    const written = '{\\"verification_error\\":{\\"code\\":\\"x\\"},\\"emails_sent_at\\":[\\"2026-11-04T12:30:45Z\\"]}';
    const statements = c.statements.map((s) => {
      if (s.sql.includes("FOR UPDATE")) return { ...s, result: { ...s.result, rows: [[stored]] } };
      if (s.sql.startsWith("UPDATE"))
        return { ...s, sql: s.sql.replace(/`json_data` = '.*' WHERE/u, `\`json_data\` = '${written}' WHERE`) };
      return s;
    });
    const { sql, error } = await run(c, statements);

    expect(error).toBeNull();
    expect(sql.log).toEqual(sql.expected);
    expect(sql.log.find((s) => s.startsWith("UPDATE"))).toContain("verification_error");
  });
});
