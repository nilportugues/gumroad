// Replays url-redirect-writes.golden.json (scripts/golden/url-redirect-writes.rb): `Purchase.find(id).create_url_redirect!`
// run by the real models against MySQL. Node must send the statements Rails sent, given the same answers.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { findPurchaseBang } from "./purchase.ts";
import { createUrlRedirectForPurchase, setUrlRedirectTokenGenerator } from "./url-redirect.ts";

type UrlRedirectWritesCase = { name: string; error: { class: string; message: string } | null; statements: Statement[]; rows: Record<string, { rows: unknown[][] }> };
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/url-redirect-writes.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  cases: UrlRedirectWritesCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));

afterEach(() => setUrlRedirectTokenGenerator(null));

describe("Purchase#create_url_redirect!", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      // SecureRandom.hex is pinned to 1, 2, ... as 32 hex digits in the generator.
      let sequence = 0;
      setUrlRedirectTokenGenerator(() => (++sequence).toString(16).padStart(32, "0"));
      let error: unknown = null;
      try {
        const purchaseId = Number(/`purchases`\.`id` = (\d+)/u.exec(c.statements[0]!.sql)![1]);
        const purchase = await findPurchaseBang(BigInt(purchaseId));
        await createUrlRedirectForPurchase(purchase, { now });
      } catch (e) {
        error = e;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
    });
  }
});
