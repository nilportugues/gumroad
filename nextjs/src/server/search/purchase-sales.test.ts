import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT, salesCentsTotal } from "./purchase-sales.ts";
import { setEsSender, type EsRequest } from "./transport.ts";

// Replays sales-cents-total.golden.json, recorded from the real User#sales_cents_total against
// Elasticsearch by spec/models/user/sales_cents_total_spec.rb: each request must be the one Rails
// sent, byte for byte, and the recorded answers must add up to the total Rails got.
type Exchange = { method: string; path: string; query: Record<string, string>; body: string; status: number; response: unknown };
type Case = { name: string; user_id: number; index: string; total: number; eligible_for_store_agent: boolean | null; exchanges: Exchange[] };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/sales-cents-total.golden.json", import.meta.url), "utf8")) as { cases: Case[] };

// Rails' specs run against the purchase-test index; the port names it from ES_INDEX_SUFFIX.
const RECORDED_INDEX = "purchase-test";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

function replay(exchanges: Exchange[]) {
  const sent: EsRequest[] = [];
  const queue = [...exchanges];
  restore = setEsSender(async (request) => {
    sent.push(request);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${request.method} ${request.path}`);
    return { status: next.status, body: next.response };
  });
  return sent;
}

describe("User#sales_cents_total", () => {
  it("has recorded cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(6);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", async (_name, recorded) => {
    expect(recorded.index).toBe(RECORDED_INDEX);
    const exchanges = recorded.exchanges.slice(0, 2);
    const sent = replay(exchanges);

    const total = await salesCentsTotal(BigInt(recorded.user_id));

    expect(total).toBe(recorded.total);
    const normalized = sent.map((request) => ({ method: request.method, path: request.path.replace(/^\/purchases\//, `/${RECORDED_INDEX}/`), query: request.query ?? {}, body: request.body }));
    expect(normalized).toEqual(exchanges.map(({ method, path, query, body }) => ({ method, path: `/${path}`, query, body })));
  });

  it("clears the store agent bar exactly as Rails does for the recorded sellers", async () => {
    const eligibility = golden.cases.filter((c) => c.eligible_for_store_agent !== null);
    expect(eligibility.length).toBe(2);
    for (const recorded of eligibility) {
      replay(recorded.exchanges.slice(0, 2));
      expect((await salesCentsTotal(BigInt(recorded.user_id))) >= MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT).toBe(recorded.eligible_for_store_agent);
      restore?.();
    }
  });
});
