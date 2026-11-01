import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { goldenIvs, goldenRouter, identityOf, type MessageCase, useGoldenEnvironment } from "./__fixtures__/application-mailer-golden.ts";
import type { MailerLevel } from "./mailer-info.ts";
import { composeMail } from "./compose.ts";
import { renderNodeMailer } from "./delivery.ts";
import { deserializeArgument } from "./ruby-value.ts";
import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import type { Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";

type CustomerCase = MessageCase & { mailer_level?: { via: string; level: MailerLevel } };
type ErrorCase = { name: string; mailer: string; method: string; job_args: JsonValue[]; statements: Statement[]; error: { class: string; message: string } };
const golden = JSON.parse(readFileSync(new URL("__fixtures__/customer-mailer.golden.json", import.meta.url), "utf8")) as {
  now: string;
  secrets: Record<string, string>;
  cases: { messages: CustomerCase[]; errors: ErrorCase[] };
};

let restore: () => void;
beforeAll(() => {
  restore = useGoldenEnvironment();
});
afterAll(() => restore());

describe("CustomerMailer", () => {
  for (const c of golden.cases.messages) {
    it(`delivers ${c.method} (${c.name}) as Rails does`, async () => {
      const replay = sqlReplay(c.statements);
      const router = goldenRouter({ features: c.features, redis: c.redis_before, rands: c.rands_used });
      const rendered = await renderNodeMailer(c.mailer, c.method, c.job_args.map(deserializeArgument), {
        router,
        randomIv: goldenIvs(),
        now: () => new Date(golden.now),
        mailerLevel: async () => c.mailer_level?.level ?? null,
      });
      expect(replay.log).toEqual(replay.expected);
      if (c.delivered.length === 0) {
        expect(rendered).toBeNull();
        return;
      }
      const delivered = c.delivered[0]!;
      expect(rendered!.html).toBe(c.rendered_html);
      const composed = composeMail(rendered!, { identity: identityOf(delivered.encoded) })!;
      expect(composed.encoded).toBe(delivered.encoded);
      expect([composed.envelopeFrom, composed.envelopeTo]).toEqual([delivered.envelope_from, delivered.envelope_to]);
      const { address, domain, user_name, password } = delivered.settings;
      expect(composed.smtp).toEqual({ address, domain, user_name, password });
      expect(Object.fromEntries(router.redis)).toEqual(c.redis_after);
    });
  }

  for (const c of golden.cases.errors) {
    it(`fails ${c.method} (${c.name}) with Rails' error`, async () => {
      const replay = sqlReplay(c.statements);
      await expect(renderNodeMailer(c.mailer, c.method, c.job_args.map(deserializeArgument), { mailerLevel: async () => null })).rejects.toThrow(c.error.message);
      expect(replay.log).toEqual(replay.expected);
    });
  }
});
