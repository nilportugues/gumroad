// Replays processor-payment-intent.golden.json (scripts/golden/processor-payment-intent.rb): the real
// Order::ChargeService#save_processor_payment_intent!. Node must send the statements Rails sent between the "save" markers.
import { readFileSync } from "node:fs";

import type { Purchase } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";

import { parseInsert } from "./__fixtures__/sql-insert.ts";
import { saveProcessorPaymentIntentBang } from "./processor-payment-intent.ts";
import { Purchases } from "./purchase-create.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";

type Entry = Statement | { marker: string; phase: string };
type Case = {
  name: string;
  seed: string[];
  statements: Entry[];
  error: { class: string; message: string } | null;
  intent_id: string | null;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/processor-payment-intent.golden.json", import.meta.url), "utf8"),
) as unknown as { now: string; cases: Case[] };
const NOW = new Date(golden.now);

const isSql = (entry: Entry): entry is Statement => "sql" in entry;
const isMarker = (entry: Entry, phase: string) => "marker" in entry && entry.marker === "save" && entry.phase === phase;
const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
const typed = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );

function setup(c: Case) {
  const start = c.statements.findIndex((entry) => isMarker(entry, "start"));
  const end = c.statements.findIndex((entry, i) => i > start && isMarker(entry, "end"));
  const row = c.seed.map(parseInsert).find((parsed) => parsed.table === "purchases")!.row;
  return {
    span: c.statements.slice(start + 1, end),
    purchase: Purchases.load(castRow<Purchase>("Purchase", typed(row))),
  };
}

describe("save_processor_payment_intent!", () => {
  for (const c of golden.cases) {
    it(`sends the statements of ${c.name}`, async () => {
      const { span, purchase } = setup(c);
      const sql = sqlReplay(span.filter(isSql));

      const error = await withExecutor(() =>
        saveProcessorPaymentIntentBang(purchase, c.intent_id, { now: () => NOW }),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(sql.log).toEqual(span.filter(isSql).map((statement) => statement.sql));
      if (c.error) {
        expect(error).toBeInstanceOf(RecordInvalid);
        expect((error as Error).message).toBe(c.error.message);
      } else {
        expect(error).toBeNull();
      }
    });
  }
});
