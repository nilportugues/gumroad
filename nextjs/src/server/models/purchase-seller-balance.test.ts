// Replays purchase-seller-balance.golden.json (scripts/golden/purchase-seller-balance.rb): the real Purchase#increment_sellers_balance!
// against a scratch database. Node must send the statements Rails sent between the "increment" markers, push the same jobs, and
// refuse (before any statement that writes) the shapes it does not serve.
import { readFileSync } from "node:fs";

import type { Link, Purchase, User } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";

import { parseInsert } from "./__fixtures__/sql-insert.ts";
import type { SellerFlowOfFunds } from "./balance-transaction-amounts.ts";
import { Purchases, withContext, type PurchaseContext } from "./purchase-create.ts";
import { incrementSellersBalanceBang } from "./purchase-seller-balance.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";
import { NotPortedError } from "./user.ts";

type Entry = Statement | { marker: string; phase: string } | { job: string; queue: string };
type Amount = { currency: string; cents: number } | null;
type Case = {
  name: string;
  seed: string[];
  statements: Entry[];
  error: { class: string; message: string } | null;
  flow_of_funds: { issued: Amount; settled: Amount; gumroad: Amount; gross: Amount; net: Amount };
  purchase_success_balance_id: number | null;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/purchase-seller-balance.golden.json", import.meta.url), "utf8"),
) as unknown as { now: string; cases: Case[] };
const NOW = new Date(golden.now);

const isSql = (entry: Entry): entry is Statement => "sql" in entry;
const isMarker = (entry: Entry, phase: string) =>
  "marker" in entry && entry.marker === "increment" && entry.phase === phase;

const jobs: { jobClass: string; args: unknown[]; options: unknown }[] = [];
let onJob: (jobClass: string) => void = () => {};
vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  performAsync: vi.fn((jobClass: string, args: unknown[], options: unknown) => {
    jobs.push({ jobClass, args, options });
    onJob(jobClass);
    return Promise.resolve("jid");
  }),
}));

afterEach(() => {
  jobs.length = 0;
  onJob = () => {};
});

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
const typed = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );

// The span the method ran in, and the purchase, link and seller Rails had loaded when it started.
function setup(c: Case) {
  const start = c.statements.findIndex((entry) => isMarker(entry, "start"));
  const end = c.statements.findIndex((entry, i) => i > start && isMarker(entry, "end"));
  const span = c.statements.slice(start + 1, end);
  const rows = c.seed.map(parseInsert);
  const row = (table: string) => typed(rows.find((parsed) => parsed.table === table)!.row);
  const purchase = Purchases.load(castRow<Purchase>("Purchase", row("purchases")));
  const context: PurchaseContext = {
    link: castRow<Link>("Link", row("links")),
    seller: castRow<User>("User", row("users")),
    buyerByEmail: null,
  };
  return { span, purchase: withContext(purchase, context) };
}

const flowOf = (c: Case): SellerFlowOfFunds => {
  const f = c.flow_of_funds;
  return {
    issuedAmount: f.issued!,
    settledAmount: f.settled!,
    gumroadAmount: f.gumroad!,
    merchantAccountGrossAmount: f.gross,
    merchantAccountNetAmount: f.net,
  };
};

const REFUSED = new Map([
  ["a sale with an affiliate credit", "an affiliate credit"],
  ["a sale with a buyer-currency presentment", "a buyer-currency presentment"],
  ["a purchase with no merchant account is Stripe's and books", "no merchant account"],
]);

describe("Purchase#increment_sellers_balance!", () => {
  for (const c of golden.cases.filter((candidate) => !REFUSED.has(candidate.name))) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const { span, purchase } = setup(c);
      const sql = sqlReplay(span.filter(isSql));
      onJob = (jobClass) => sql.log.push(`JOB ${jobClass}`);
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));

      await withExecutor(() => incrementSellersBalanceBang(purchase, { flowOfFunds: flowOf(c) }, { now: () => NOW }));

      expect(sql.log).toEqual(expected);
      expect(purchase.get("purchase_success_balance_id")).toBe(c.purchase_success_balance_id);
    });
  }

  for (const [name, reason] of REFUSED) {
    it(`hands back ${name} before it sends a write`, async () => {
      const c = golden.cases.find((candidate) => candidate.name === name)!;
      const { span, purchase } = setup(c);
      const sql = sqlReplay(span.filter(isSql));

      const error = await withExecutor(() =>
        incrementSellersBalanceBang(purchase, { flowOfFunds: flowOf(c) }, { now: () => NOW }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotPortedError);
      expect((error as Error).message).toContain(reason);
      expect(sql.log.filter((statement) => !statement.startsWith("SELECT"))).toEqual([]);
    });
  }
});
