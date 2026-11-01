// Replays the jobs in receipt-mailer.golden.json (generate-receipt-mailer-golden.rb): SendPurchaseReceiptJob as
// Sidekiq runs it against rows in a scratch database. The statements, the mail and the CustomerEmailInfo write
// must match; a case the port hands back must have sent and written nothing.
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { goldenRouter, useGoldenEnvironment } from "../../server/mail/__fixtures__/application-mailer-golden.ts";
import type { ComposedMail } from "../../server/mail/compose.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, sequentialJids } from "./__fixtures__/golden.ts";
import { setEsSender } from "../../server/search/transport.ts";
import { type Statement, sqlReplay } from "./__fixtures__/sql-replay.ts";
import { sendPurchaseReceiptJobWith } from "./send-purchase-receipt-job.ts";

type JobCase = {
  name: string;
  args: JsonValue[];
  statements: Statement[];
  error: { class: string; message: string } | null;
  ivs: string[];
  rands_used: number[];
  features: string[];
  delivered: { encoded: string; envelope_to: string[]; settings: { address: string; domain: string; password: string } }[];
  stamp_jobs: string[];
  email_infos: unknown[];
  es: { body: string; status: number; response: Record<string, unknown> }[];
};
const golden = JSON.parse(readFileSync(new URL("../../server/mail/__fixtures__/receipt-mailer.golden.json", import.meta.url), "utf8")) as {
  now: string;
  secrets: Record<string, string>;
  cases: { jobs: JobCase[] };
};

// The jobs Rails hands to Node's replay of Rails' own decision, not to Node's.
const HANDED_BACK = ["job_stampable_pdf"];

let restore: () => void;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  restore = useGoldenEnvironment();
  for (const [key, value] of Object.entries(golden.secrets)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  restore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Date, Message-ID and boundary are random on both sides.
const stable = (encoded: string) => encoded.replace(/^(Date|Message-ID): .*$/gmu, "$1: x").replace(/--==_mimepart_[\w-]+/gu, "B");

let restoreEs: (() => void) | undefined;
afterEach(() => restoreEs?.());

describe("SendPurchaseReceiptJob", () => {
  for (const c of golden.cases.jobs) {
    it(c.name, async () => {
      const now = new Date(golden.now);
      const sql = sqlReplay(c.statements);
      const sentToEs: string[] = [];
      const queue = [...c.es];
      restoreEs = setEsSender(async (request) => {
        sentToEs.push(String(request.body));
        const next = queue.shift();
        if (!next) throw new Error(`unexpected Elasticsearch request ${request.method} ${request.path}`);
        return { status: next.status, body: next.response };
      });
      const sent: ComposedMail[] = [];
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, now: () => now.getTime() / 1000, newJid: sequentialJids() });
      let draws = 0;
      const handler = sendPurchaseReceiptJobWith({
        now: () => new Date(now),
        mail: {
          send: async (mail) => {
            sent.push(mail);
          },
          log: () => {},
          mailer: {
            router: goldenRouter({ features: c.features, redis: {}, rands: c.rands_used }),
            mailerLevel: async () => "level_1",
            randomIv: () => Buffer.from(c.ivs[draws++]!, "base64"),
          },
        },
      });

      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime)), now.getTime() / 1000);
      } catch (e) {
        error = e;
      }

      if (HANDED_BACK.includes(c.name)) {
        // Rails sends the mail itself: the port read what it needed, then gave the job back unwritten.
        expect(error).toBeInstanceOf(HandBackToRuby);
        expect(sent).toEqual([]);
        expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
        expect(sql.log.some((statement) => /^(INSERT|UPDATE|DELETE|BEGIN)/u.test(statement))).toBe(false);
        expect(recording.snapshot()).toEqual({});
        return;
      }

      expect(sql.log).toEqual(sql.expected);
      expect(sentToEs).toEqual(c.es.map((exchange) => exchange.body));
      if (c.error) {
        expect((error as Error).message).toBe(c.error.message);
      } else {
        expect(error).toBeNull();
      }
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
