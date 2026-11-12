// Shared by the replays of purchase-create.golden.json (scripts/golden/purchase-create.rb): the recording and the purchase the
// service handed the first save, rebuilt from the INSERT and the seed rows.
import { readFileSync } from "node:fs";

import type { Link, Purchase, User } from "@prisma/client";

import type { Statement } from "../../../worker/jobs/__fixtures__/sql-replay.ts";
import { parseRubyJson } from "../../jobs/sidekiq/ruby-json.ts";
import { Purchases, withContext, type PurchaseContext } from "../purchase-create.ts";
import { castRow } from "../sql.ts";

import { parseInsert } from "./sql-insert.ts";

export type Entry = Statement | { marker: string; phase: string } | { job: string; queue: string };
export type GoldenCase = { name: string; seed: string[]; statements: Entry[]; request: unknown };
export const golden = parseRubyJson(
  readFileSync(new URL("./purchase-create.golden.json", import.meta.url), "utf8"),
) as unknown as {
  now: string;
  cases: GoldenCase[];
};
export const NOW = new Date(golden.now);

export const isSql = (entry: Entry): entry is Statement => "sql" in entry;
export const isMarker = (entry: Entry, phase: string): boolean =>
  "marker" in entry && entry.marker === "Purchase#save" && entry.phase === phase;

// The statements and job pushes between the first "Purchase#save" markers: the purchase's create, its commit and its hooks.
export function firstSaveSpan(c: GoldenCase): Entry[] {
  const start = c.statements.findIndex((entry) => isMarker(entry, "start"));
  const end = c.statements.findIndex((entry, i) => i > start && isMarker(entry, "end"));
  return c.statements.slice(start + 1, end);
}

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
const typed = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );

function seededRow(c: GoldenCase, table: string): Record<string, unknown> {
  const insert = c.seed.map(parseInsert).find((parsed) => parsed.table === table);
  if (!insert) throw new Error(`${c.name}: no ${table} seed row`);
  return typed(insert.row);
}

// What the service handed the save: the INSERT's attributes, without the ones the save stamps.
export function buildPurchase(c: GoldenCase, span: Entry[]) {
  const insert = span.filter(isSql).find((s) => s.sql.startsWith("INSERT INTO `purchases`"))!;
  const { row } = parseInsert(insert.sql);
  // The service hands the save the email as the buyer typed it; the model strips and downcases it when it validates.
  const typedEmail = (c.request as { email?: string }).email;
  const attributes = castRow<Purchase>(
    "Purchase",
    typed({ ...row, ...(typedEmail === undefined ? {} : { email: typedEmail }), created_at: null, updated_at: null }),
  );
  const link = castRow<Link>("Link", seededRow(c, "links"));
  const seller = castRow<User>("User", seededRow(c, "users"));
  const policy = span.filter(isSql).find((s) => s.sql.startsWith("INSERT INTO `purchase_refund_policies`"));
  const refundPolicy = policy ? (parseInsert(policy.sql).row as PurchaseContext["refundPolicy"]) : null;
  const users = c.seed.map(parseInsert).filter((parsed) => parsed.table === "users");
  const buyerRow = users.find((parsed) => parsed.row.email === typedEmail)?.row;
  const purchaserRow = users.find((parsed) => BigInt(parsed.row.id as number) === attributes.purchaser_id)?.row;
  const context: PurchaseContext = {
    link,
    seller,
    geoInfo: null,
    refundPolicy,
    buyerByEmail: buyerRow ? castRow<User>("User", typed(buyerRow)) : null,
    buyerLookupEmail: typedEmail,
    purchaserEmail: purchaserRow ? (purchaserRow.email as string) : undefined,
  };
  return withContext(Purchases.build(attributes), context);
}
