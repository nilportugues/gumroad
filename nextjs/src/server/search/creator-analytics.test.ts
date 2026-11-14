import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { Fetcher } from "../page-props/analytics/churn.ts";
import { CreatorAnalyticsSales } from "./creator-analytics-sales.ts";
import { addDays } from "./civil-time.ts";
import { setEsSender, type EsRequest } from "./transport.ts";

// Replays creator-analytics.golden.json, recorded by generate-creator-analytics-golden.rb from the real
// CreatorAnalytics::Sales and Churn::ElasticsearchFetcher against Elasticsearch 7.17 through a proxy that kept
// the wire bytes.
type Exchange = { method: string; path: string; body: string; status: number; response: Record<string, unknown> };
type Entry = { key: string[]; value: unknown };
type Case = {
  kind: "sales" | "churn";
  name: string;
  timezone: string;
  from: string;
  to: string;
  method?: "by_product_and_date" | "by_product_and_country_and_state" | "by_product_and_referrer_and_date";
  interval?: string;
  product_ids: number[] | null;
  outcome: { error?: { class: string; message: string } } & Record<string, unknown> & unknown[];
  exchanges: Exchange[];
};
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/creator-analytics.golden.json", import.meta.url), "utf8")) as { index: string; cases: Case[] };

const SELLER_ID = 42;
let restore: (() => void) | undefined;
afterEach(() => restore?.());

const datesOf = (from: string, to: string) => {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
};

// The golden writes nil keys as empty strings.
const asStrings = (entries: { key: unknown[]; value: unknown }[]): Entry[] => entries.map(({ key, value }) => ({ key: key.map((part) => (part === null ? "" : String(part))), value }));

function replay(recorded: Case) {
  const sent: EsRequest[] = [];
  const queue = [...recorded.exchanges];
  restore = setEsSender(async (request) => {
    sent.push(request);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${request.method} ${request.path}`);
    return { status: next.status, body: next.response };
  });
  return { sent, queue };
}

describe("CreatorAnalytics::Sales", () => {
  const cases = golden.cases.filter((recorded) => recorded.kind === "sales");

  it("has recorded cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  it.each(cases.map((recorded) => [recorded.name, recorded] as const))("%s", async (_name, recorded) => {
    const { sent, queue } = replay(recorded);
    const user = { id: SELLER_ID, timezone: recorded.timezone };
    const products = recorded.product_ids?.map((id) => ({ id })) ?? null;

    let outcome: unknown;
    try {
      const sales = new CreatorAnalyticsSales(user, datesOf(recorded.from, recorded.to), products, recorded.interval);
      const method = { by_product_and_date: "byProductAndDate", by_product_and_country_and_state: "byProductAndCountryAndState", by_product_and_referrer_and_date: "byProductAndReferrerAndDate" }[recorded.method!] as
        | "byProductAndDate"
        | "byProductAndCountryAndState"
        | "byProductAndReferrerAndDate";
      outcome = asStrings(await sales[method]());
    } catch (error) {
      outcome = { error: { class: (error as { rubyClass?: string }).rubyClass ?? (error as Error).name, message: (error as Error).message } };
    }

    expect(sent.map((request) => request.body)).toEqual(recorded.exchanges.map((exchange) => exchange.body));
    expect(outcome).toEqual(recorded.outcome);
    expect(queue).toEqual([]);
  });
});

describe("CreatorAnalytics::Churn::ElasticsearchFetcher", () => {
  const cases = golden.cases.filter((recorded) => recorded.kind === "churn");

  it("has recorded cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it.each(cases.map((recorded) => [recorded.name, recorded] as const))("%s", async (_name, recorded) => {
    const { sent, queue } = replay(recorded);
    const seller = { id: SELLER_ID, timezone: recorded.timezone, created_at: new Date() };
    const productIds = recorded.product_ids!;
    // The fetcher returns nothing, and sends nothing, without products.
    const fetcher = new Fetcher(seller, productIds, { startDate: recorded.from, endDate: recorded.to });
    const split = (key: string) => key.split("|");

    const churnEvents = productIds.length === 0 ? new Map() : await fetcher.churnEvents();
    const newSubscriptions = productIds.length === 0 ? new Map() : await fetcher.newSubscriptions();
    const initialActive = productIds.length === 0 ? new Map() : await fetcher.initialActiveCounts();
    const outcome = {
      churn_events: [...churnEvents].map(([key, value]) => ({ key: split(key), value })),
      new_subscriptions: [...newSubscriptions].map(([key, value]) => ({ key: split(key), value })),
      initial_active_counts: [...initialActive].map(([key, value]) => ({ key: [String(key)], value })),
    };

    expect(sent.map((request) => request.body)).toEqual(recorded.exchanges.map((exchange) => exchange.body));
    expect(outcome).toEqual(recorded.outcome);
    expect(queue).toEqual([]);
  });
});
