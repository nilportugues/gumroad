// Replays the jobs in application-mailer.golden.json, which the real Rails app ran against MySQL:
// the Node port must send the statements Rails sent (given the same answers) and the same mail,
// and push the same Sidekiq payload.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { golden, goldenRouter, useGoldenEnvironment } from "../../server/mail/__fixtures__/application-mailer-golden.ts";
import type { ComposedMail } from "../../server/mail/compose.ts";
import { SmtpError } from "../../server/mail/smtp.ts";
import { contextFor, recordingSidekiqRedis, sequentialJids } from "./__fixtures__/golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { disputeEvidenceDueSoonReminderJob } from "./dispute-evidence-due-soon-reminder-job.ts";
import { sendMarketingXReconnectEmailJobWith } from "./send-marketing-x-reconnect-email-job.ts";

let restore: () => void;
beforeAll(() => {
  restore = useGoldenEnvironment();
});
afterAll(() => restore());

const now = new Date(golden.now);
// The SMTP failures generate-application-mailer-golden.rb injected, by case.
const SMTP_FAILURES: Record<string, SmtpError[]> = {
  "first mail rejected by SMTP": [new SmtpError("Net::SMTPFatalError", "550 5.7.1 rejected")],
  "SMTP timeout": [new SmtpError("Net::OpenTimeout", "execution expired")],
};

describe("SendMarketingXReconnectEmailJob", () => {
  for (const c of golden.cases.jobs) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const failures = [...(SMTP_FAILURES[c.name] ?? [])];
      const sent: ComposedMail[] = [];
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, now: () => now.getTime() / 1000, newJid: sequentialJids() });
      const handler = sendMarketingXReconnectEmailJobWith({
        now: () => new Date(now),
        mail: {
          send: async (mail) => {
            const failure = failures.shift();
            if (failure) throw failure;
            sent.push(mail);
          },
          log: () => {},
          mailer: { router: goldenRouter({ features: [], redis: {}, rands: [] }) },
        },
      });

      let error: unknown = null;
      try {
        await handler(c.args, contextFor(runtime));
      } catch (e) {
        error = e;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : error instanceof SmtpError ? error.rubyClass : (error as Error).name).toEqual(c.error?.class ?? null);
      expect(sent.length).toBe(c.delivered.length);
      sent.forEach((mail, i) => {
        const delivered = c.delivered[i]!;
        expect(stable(mail.encoded)).toBe(stable(delivered.encoded));
        expect(mail.envelopeTo).toEqual(delivered.envelope_to);
        expect(mail.smtp).toMatchObject({ address: delivered.settings.address, domain: delivered.settings.domain, password: delivered.settings.password });
      });
      expect(recording.snapshot()).toEqual({});
    });
  }
});

// Date, Message-ID and boundary are random on both sides.
const stable = (encoded: string) => encoded.replace(/^(Date|Message-ID): .*$/gmu, "$1: x").replace(/--==_mimepart_[\w-]+/gu, "B");

describe("DisputeEvidenceDueSoonReminderJob", () => {
  it("pushes ContactingCreatorMailer#chargeback_evidence_due_soon for Rails, as deliver_later does", async () => {
    const recording = recordingSidekiqRedis();
    const { dispute_reminder: c } = golden.cases;
    const expected = c.queued.map((payload) => parseRubyJson(payload) as Record<string, JsonValue>);
    // The jid and job_id are random in Ruby; the jid is reused here, the job_id ignored.
    const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, now: () => c.now, newJid: () => String(expected[0]!.jid) });
    await disputeEvidenceDueSoonReminderJob(c.args, contextFor(runtime));
    const queued = (recording.snapshot()["queue:default"]?.value as string[]).map((payload) => parseRubyJson(payload) as Record<string, JsonValue>);
    const withoutJobId = (item: Record<string, JsonValue>) => ({ ...item, args: (item.args as Record<string, JsonValue>[]).map(({ job_id: _, ...job }) => job) });
    expect(queued.map(withoutJobId)).toEqual(expected.map(withoutJobId));
  });
});
