import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { esJson } from "./es-json.ts";
import { ALL_SUCCESS_STATES, PurchaseSearchService } from "./purchase-search.ts";
import type { Params } from "./ruby-params.ts";
import { setEsSender, type EsRequest } from "./transport.ts";

// Replays purchase-search.golden.json, recorded by generate-purchase-search-golden.rb from the real
// PurchaseSearchService against Elasticsearch 7.17 through a proxy that kept the wire bytes.
type Exchange = { method: string; path: string; body: string; status: number; response: Record<string, unknown> };
type Case = { name: string; options: Params; outcome: { total: number | null; ids: string[] }; body: string; exchanges: Exchange[] };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/purchase-search.golden.json", import.meta.url), "utf8")) as {
  all_success_states: string[];
  cases: Case[];
};

// {"$time" => [y, m, d, h, mi, s]} in the golden is a UTC Time.
function build(options: Params): Params {
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => {
      if (typeof value === "object" && value !== null && "$time" in value) {
        const [y, m, d, h = 0, mi = 0, s = 0] = (value as { $time: number[] }).$time;
        return [key, new Date(Date.UTC(y!, m! - 1, d, h, mi, s))];
      }
      return [key, value];
    }),
  );
}

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("PurchaseSearchService", () => {
  it("has recorded cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(60);
    expect([...ALL_SUCCESS_STATES]).toEqual(golden.all_success_states);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", async (_name, recorded) => {
    const options = build(recorded.options);
    expect(esJson(new PurchaseSearchService(options).body as never)).toBe(recorded.body);

    const sent: EsRequest[] = [];
    const queue = [...recorded.exchanges];
    restore = setEsSender(async (request) => {
      sent.push(request);
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request ${request.method} ${request.path}`);
      return { status: next.status, body: next.response };
    });

    const result = await PurchaseSearchService.process(options);

    expect(sent.map((request) => request.body)).toEqual(recorded.exchanges.map((exchange) => exchange.body));
    expect({ total: result.total, ids: result.ids }).toEqual(recorded.outcome);
    expect(queue).toEqual([]);
  });
});
