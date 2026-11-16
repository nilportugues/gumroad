// Shared by the replays of the paid-sale goldens (scripts/golden/support/paid_sale.rb): the recording, the span between a case's
// markers and the purchase, link and seller Rails had loaded when the span started.
import { readFileSync } from "node:fs";

import type { Link, Purchase, User } from "@prisma/client";

import type { Statement } from "../../../worker/jobs/__fixtures__/sql-replay.ts";
import { parseRubyJson } from "../../jobs/sidekiq/ruby-json.ts";
import type { SellerFlowOfFunds } from "../balance-transaction-amounts.ts";
import { Purchases, withContext, type PurchaseContext, type PurchaseRecord } from "../purchase-create.ts";
import { castRow } from "../sql.ts";

import { parseInsert } from "./sql-insert.ts";

type Amount = { currency: string; cents: number } | null;
export type Entry =
  | Statement
  | { marker: string; phase: string }
  | { job: string; queue: string }
  | { flipper: string; actor: string | null; result: boolean };
export type GoldenCase = {
  name: string;
  seed: string[];
  statements: Entry[];
  error: { class: string; message: string } | null;
  flow_of_funds?: { issued: Amount; settled: Amount; gumroad: Amount; gross: Amount; net: Amount };
  purchase_success_balance_id?: number | null;
};

export function loadGolden(file: string): { now: Date; cases: GoldenCase[] } {
  const golden = parseRubyJson(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")) as unknown as {
    now: string;
    cases: GoldenCase[];
  };
  return { now: new Date(golden.now), cases: golden.cases };
}

export const isSql = (entry: Entry): entry is Statement => "sql" in entry;

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
const typed = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );

// The span the method ran in, and the purchase, link and seller Rails had loaded when it started.
export function setupSale(c: GoldenCase, marker: string): { span: Entry[]; purchase: PurchaseRecord } {
  const isMarker = (entry: Entry, phase: string) =>
    "marker" in entry && entry.marker === marker && entry.phase === phase;
  const start = c.statements.findIndex((entry) => isMarker(entry, "start"));
  const end = c.statements.findIndex((entry, i) => i > start && isMarker(entry, "end"));
  const rows = c.seed.map(parseInsert);
  const row = (table: string) => typed(rows.find((parsed) => parsed.table === table)!.row);
  const context: PurchaseContext = {
    link: castRow<Link>("Link", row("links")),
    seller: castRow<User>("User", row("users")),
    buyerByEmail: null,
  };
  return {
    span: c.statements.slice(start + 1, end),
    purchase: withContext(Purchases.load(castRow<Purchase>("Purchase", row("purchases"))), context),
  };
}

export function flowOf(c: GoldenCase): SellerFlowOfFunds {
  const f = c.flow_of_funds!;
  return {
    issuedAmount: f.issued!,
    settledAmount: f.settled!,
    gumroadAmount: f.gumroad!,
    merchantAccountGrossAmount: f.gross,
    merchantAccountNetAmount: f.net,
  };
}
