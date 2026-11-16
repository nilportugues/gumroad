import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sellerUpdatesWorker } from "./seller-updates-worker.ts";
import type { JobContext } from "./types.ts";

const golden = JSON.parse(readFileSync(new URL("./__fixtures__/seller-updates-worker.golden.json", import.meta.url), "utf8")) as {
  queries_during_perform: string[];
  enqueued: unknown[];
  error: string | null;
  matching_sellers_when_loaded_without_date: number[];
};

// The handler is handed no database or runtime it could use: anything it touched would throw.
const context = new Proxy({} as JobContext, {
  get(_, prop) {
    throw new Error(`SellerUpdatesWorker touched context.${String(prop)}`);
  },
});

describe("SellerUpdatesWorker", () => {
  it("runs no query and enqueues nothing, as the Ruby job does even with a matching seller", async () => {
    expect(golden.matching_sellers_when_loaded_without_date).toHaveLength(1);
    expect(golden.queries_during_perform).toEqual([]);
    expect(golden.enqueued).toEqual([]);
    expect(golden.error).toBeNull();
    await expect(sellerUpdatesWorker([], context)).resolves.toBeUndefined();
  });

  it("fails on arguments as Ruby's zero-arity perform does", async () => {
    await expect(sellerUpdatesWorker([1], context)).rejects.toThrow("wrong number of arguments (given 1, expected 0)");
  });
});
