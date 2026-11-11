// Replays link-metrics.golden.json (scripts/golden/link-metrics.rb): the five Link metrics run by the real app as a Sidekiq job
// over a seeded database and a real Elasticsearch purchases index. Node sends the statements and the Elasticsearch requests
// Rails sent, byte for byte, given the answers Rails got, and returns what Ruby returned. The two cases that need a Flipper
// feature hand back to Rails.
import { readFileSync } from "node:fs";

import type { Link } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { asSidekiqJob } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { setEsSender, type EsRequest } from "../search/transport.ts";

import {
  monthlyRecurringRevenue,
  remainingForSaleCount,
  revenuePending,
  successfulSalesCount,
  totalUsdCents,
} from "./link-metrics.ts";
import { findByIdBang } from "./row-reads.ts";

type Exchange = { method: string; path: string; query: string | null; body: string; status: number; response: unknown };
type Case = {
  name: string;
  scenario: string;
  product_id: number;
  metric: string;
  error: { class: string; message: string } | null;
  result: { class: string; value: number | string | null };
  statements: Statement[];
  exchanges: Exchange[];
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/link-metrics.golden.json", import.meta.url), "utf8"),
) as { now: number; index: string; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

// A tier closed to new purchases on a tiered membership (Ruby asks Flipper) and a bundle variant that is a Sku: Node hands back.
const HAND_BACK = new Set(["stock: product 17 remaining_for_sale_count", "stock: product 35 remaining_for_sale_count"]);

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const metrics: Record<string, (product: Link) => Promise<unknown>> = {
  successful_sales_count: successfulSalesCount,
  remaining_for_sale_count: remainingForSaleCount,
  monthly_recurring_revenue: monthlyRecurringRevenue,
  revenue_pending: (product) => revenuePending(product, now),
  total_usd_cents: totalUsdCents,
};

describe("Link metrics", () => {
  it("has a golden case for every metric and every edge the port reads", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(78);
    expect(new Set(golden.cases.map((c) => c.metric))).toEqual(new Set(Object.keys(metrics)));
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", async (_name, recorded) => {
    const sql = sqlReplay(recorded.statements);
    const sent: EsRequest[] = [];
    const queue = [...recorded.exchanges];
    restore = setEsSender(async (request) => {
      sent.push(request);
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request ${request.method} ${request.path}`);
      return { status: next.status, body: next.response };
    });

    let value: unknown;
    let error: Error | null = null;
    try {
      value = await asSidekiqJob(
        async () => metrics[recorded.metric]!(await findByIdBang<Link>("Link", BigInt(recorded.product_id))),
        golden.now,
      );
    } catch (e) {
      error = e as Error;
    }

    if (HAND_BACK.has(recorded.name)) {
      expect(error?.name).toBe("NotPortedError");
      expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
      return;
    }
    expect(error?.message ?? null).toEqual(recorded.error?.message ?? null);
    expect(sql.log).toEqual(sql.expected);
    expect(
      sent.map((r) => ({
        method: r.method,
        path: r.path.replace(/^\/purchases\//u, `/${golden.index}/`),
        body: r.body,
      })),
    ).toEqual(
      recorded.exchanges.map(({ method, path, body }) => ({ method, path: `/${path.replace(/^\//u, "")}`, body })),
    );
    if (recorded.error === null)
      expect(value === null ? null : typeof value === "bigint" ? Number(value) : value).toEqual(
        recorded.result.class === "NilClass" ? null : Number(recorded.result.value),
      );
  });
});
