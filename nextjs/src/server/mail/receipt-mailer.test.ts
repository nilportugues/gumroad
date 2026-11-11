// Replays __fixtures__/receipt-mailer.golden.json (generate-receipt-mailer-golden.rb): the real
// CustomerMailer#receipt, run as a Sidekiq job runs it (query cache on), against rows in a scratch database.
// The SecureExternalId and X-GUM header IVs are the generator's pinned sequence (a stubbed
// OpenSSL::Cipher#random_iv), handed back to the port in the order Ruby drew them.
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import type { Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { SIDEKIQ_EXECUTOR, withExecutor } from "../models/runtime/query-cache.ts";
import { setEsSender, type EsRequest } from "../search/transport.ts";

import {
  goldenRouter,
  identityOf,
  type MessageCase,
  useGoldenEnvironment,
} from "./__fixtures__/application-mailer-golden.ts";
import { composeMail } from "./compose.ts";
import { composeNodeMail, isNotPorted, renderNodeMailer } from "./delivery.ts";
import type { MailerLevel } from "./mailer-info.ts";
import { deserializeArgument } from "./ruby-value.ts";

type EsExchange = { method: string; path: string; body: string; status: number; response: Record<string, unknown> };
type ReceiptCase = MessageCase & {
  mailer_level?: { via: string; level: MailerLevel };
  ivs: string[];
  delivery_statements: Statement[];
  es: EsExchange[];
};
type ErrorCase = {
  name: string;
  mailer: string;
  method: string;
  job_args: JsonValue[];
  statements: Statement[];
  error: { class: string; message: string };
};
const golden = JSON.parse(
  readFileSync(new URL("__fixtures__/receipt-mailer.golden.json", import.meta.url), "utf8"),
) as {
  now: string;
  secrets: Record<string, string>;
  cases: { messages: ReceiptCase[]; errors: ErrorCase[]; refused: ReceiptCase[] };
};

let restore: () => void;
let restoreEs: (() => void) | undefined;
afterEach(() => restoreEs?.());

// The Elasticsearch answers Rails got, handed back request by request; what the port sends must be the bytes Rails sent.
function replayEs(exchanges: EsExchange[]): EsRequest[] {
  const sent: EsRequest[] = [];
  const queue = [...exchanges];
  restoreEs = setEsSender(async (request) => {
    sent.push(request);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected Elasticsearch request ${request.method} ${request.path}`);
    return { status: next.status, body: next.response };
  });
  return sent;
}
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

// The generator's OpenSSL::Cipher#random_iv, replayed from what each case recorded.
const recordedIvs = (ivs: string[]) => {
  let next = 0;
  return () => {
    const iv = ivs[next++];
    if (iv === undefined) throw new Error("the port drew more IVs than Ruby did");
    return Buffer.from(iv, "base64");
  };
};

describe("CustomerMailer#receipt", () => {
  for (const c of golden.cases.messages) {
    it(`delivers ${c.method} (${c.name}) as Rails does`, async () => {
      const replay = sqlReplay(c.statements);
      const sentToEs = replayEs(c.es);
      const router = goldenRouter({ features: c.features, redis: c.redis_before, rands: c.rands_used });
      const rendered = await withExecutor(
        () =>
          renderNodeMailer(c.mailer, c.method, c.job_args.map(deserializeArgument), {
            router,
            randomIv: recordedIvs(c.ivs),
            now: () => new Date(golden.now),
            mailerLevel: async () => c.mailer_level?.level ?? null,
          }),
        SIDEKIQ_EXECUTOR,
      );
      expect(replay.log).toEqual(replay.expected);
      expect(sentToEs.map((request) => request.body)).toEqual(c.es.map((exchange) => exchange.body));
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

  // Rails sends these; the port refuses them (while rendering or encoding) before it sends or writes anything.
  for (const c of golden.cases.refused) {
    it(`leaves ${c.method} (${c.name}) to Rails`, async () => {
      sqlReplay(c.statements);
      replayEs(c.es);
      const refusal = await withExecutor(
        () =>
          composeNodeMail(c.mailer, c.method, c.job_args.map(deserializeArgument), {
            router: goldenRouter({ features: [], redis: {}, rands: [] }),
            mailerLevel: async () => "level_1",
            randomIv: recordedIvs(c.ivs),
          }),
        SIDEKIQ_EXECUTOR,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(isNotPorted(refusal)).toBe(true);
    });
  }

  for (const c of golden.cases.errors) {
    it(`fails ${c.method} (${c.name}) with Rails' error`, async () => {
      const replay = sqlReplay(c.statements);
      await expect(
        withExecutor(
          () =>
            renderNodeMailer(c.mailer, c.method, c.job_args.map(deserializeArgument), {
              mailerLevel: async () => "level_1",
            }),
          SIDEKIQ_EXECUTOR,
        ),
      ).rejects.toThrow(c.error.message);
      expect(replay.log).toEqual(replay.expected);
    });
  }
});
