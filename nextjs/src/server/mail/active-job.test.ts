import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sidekiqPushCommand } from "../jobs/sidekiq/client.ts";
import { type ActiveJobArgument, buildMailDeliveryItem, iso8601Nanos, record, symbolHash } from "./active-job.ts";

type EnqueueCase = { name: string; kind: "enqueue"; queued: string[]; scheduled: { payload: string; score: string }[] };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/mail.golden.json", import.meta.url), "utf8")) as { cases: { kind: string; name: string }[] };
const enqueues = new Map(golden.cases.filter((c): c is EnqueueCase => c.kind === "enqueue").map((c) => [c.name, c]));

// Ruby reads the clock separately for created_at, enqueued_at and the job's timestamps.
const normalize = (payload: string) =>
  payload
    .replace(/"(enqueued_at|scheduled_at)":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}000Z"/gu, '"$1":"<time>"')
    .replace(/"(created_at|enqueued_at)":\d+\.\d+/gu, '"$1":<float>');

const CASES: [string, { mailer: string; method: string; args: ActiveJobArgument[]; queue?: string; waitSeconds?: number }][] = [
  ["deliver_later_confirmation", { mailer: "UserSignupMailer", method: "confirmation_instructions", args: [record("User", 1234), "raw-token", symbolHash({})], queue: "critical", waitSeconds: 3 }],
  [
    "deliver_later_reconfirmation",
    { mailer: "UserSignupMailer", method: "confirmation_instructions", args: [record("User", 5678), "raw-token", symbolHash({ to: "new+tag@example.org" })], queue: "critical", waitSeconds: 3 },
  ],
  ["deliver_later_email_changed", { mailer: "UserSignupMailer", method: "email_changed", args: [record("User", 5678), symbolHash({ to: "old@example.com" })], queue: "critical", waitSeconds: 3 }],
  ["deliver_later_default_queue", { mailer: "UserSignupMailer", method: "email_changed", args: [record("User", 5678), symbolHash({})] }],
];

describe("buildMailDeliveryItem", () => {
  for (const [name, input] of CASES) {
    it(`pushes ${name} as ActionMailer's deliver_later does`, () => {
      const c = enqueues.get(name)!;
      const expected = c.scheduled[0]?.payload ?? c.queued[0]!;
      const parsed = JSON.parse(expected) as { jid: string; created_at: number; args: { job_id: string }[] };
      const now = parsed.created_at;
      const command = sidekiqPushCommand(buildMailDeliveryItem(input, { jobId: parsed.args[0]!.job_id, jid: parsed.jid, now }), now);
      expect(normalize(command.payload)).toBe(normalize(expected));
      if (c.scheduled[0]) {
        expect(command.kind).toBe("schedule");
        expect(Number(command.kind === "schedule" ? command.score : 0)).toBeCloseTo(Number(c.scheduled[0].score), 1);
      } else {
        expect(command).toMatchObject({ kind: "queue", queue: "default" });
      }
    });
  }

  it("formats timestamps as Time#iso8601(9)", () => {
    expect(iso8601Nanos(1793466071.2469308)).toBe("2026-10-31T17:01:11.246931000Z");
    expect(iso8601Nanos(1793466068)).toBe("2026-10-31T17:01:08.000000000Z");
  });
});
