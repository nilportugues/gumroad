import { readFileSync } from "node:fs";

import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calculateTaxForOrder, taxjarEndpoint, taxjarWire, type TaxjarOrder } from "./taxjar.ts";

// Recorded by scripts/golden/taxjar-api.rb: TaxjarApi#calculate_tax_for_order through the real class and the taxjar-ruby gem, twice
// per case, with TaxJar answered by a WebMock stand-in.
type Answer = { status?: number; body?: string; headers?: Record<string, string>; dropped?: boolean };
type GoldenCase = {
  name: string;
  order: {
    origin: { country: string; state: string; zip: string };
    destination: { country: string; state: string | null; zip: string | null };
    nexus_address: { country: string; state: string | null };
    quantity: number;
    product_tax_code: string | null;
    unit_price_dollars: number;
    shipping_dollars: number;
  };
  http_responses: Answer[];
  http: { method: string; url: string; headers: Record<string, string>; body: string }[];
  results: { value?: { amount_to_collect?: unknown }; raised?: string }[];
  memo: { key: string; value: string; ttl: number }[];
  notified: string[];
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/taxjar-api.golden.json", import.meta.url), "utf8"),
) as GoldenCase[];

// TaxjarErrors the port answers with the lookup table; the rest also notify the error tracker, which Node does not do.
const FALLBACK_ERRORS = [
  "Taxjar::Error::BadRequest",
  "Taxjar::Error::NotFound",
  "Taxjar::Error::InternalServerError",
  "Taxjar::Error::ServiceUnavailable",
  "Errno::ECONNRESET",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// calculate_with_taxjar reads amount_to_collect, then breakdown and jurisdictions; anything else raises in Ruby.
const usable = (value: unknown) =>
  isRecord(value) &&
  typeof value.amount_to_collect === "number" &&
  isRecord(value.breakdown) &&
  isRecord(value.jurisdictions);

beforeEach(() => {
  vi.stubEnv("RAILS_ENV", "test");
  vi.stubEnv("TAXJAR_ENDPOINT", "");
  vi.stubEnv("TAXJAR_API_KEY", "taxjar-key");
});
afterEach(() => vi.unstubAllEnvs());

const toOrder = (entry: GoldenCase): TaxjarOrder => ({
  originCountry: entry.order.origin.country,
  originState: entry.order.origin.state,
  originZip: entry.order.origin.zip,
  destinationCountry: entry.order.destination.country,
  destinationState: entry.order.destination.state,
  destinationZip: entry.order.destination.zip,
  quantity: entry.order.quantity,
  productTaxCode: entry.order.product_tax_code,
  unitPriceDollars: entry.order.unit_price_dollars,
  shippingDollars: entry.order.shipping_dollars,
});

function stand(answers: Answer[]) {
  const queue = [...answers];
  const sent: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
    });
    const answer = queue.shift() ?? {};
    if (answer.dropped)
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    return Promise.resolve(
      new Response(answer.body ?? "{}", { status: answer.status ?? 200, headers: answer.headers ?? {} }),
    );
  });
  return { fetcher: fetcher as unknown as typeof fetch, sent };
}

function memory() {
  const store = new Map<string, { value: string; ttl: number }>();
  const get = vi.fn((key: string) => Promise.resolve(store.get(key)?.value ?? null));
  const set = vi.fn((key: string, value: string, _ex: string, ttl: number) =>
    Promise.resolve(void store.set(key, { value, ttl })),
  );
  return { store, get, client: { get, set } as unknown as Redis };
}

// The order's nexus address is always the destination in SalesTaxCalculator; the port has no parameter for another.
const cases = golden.filter(
  (entry) =>
    entry.order.nexus_address.country === entry.order.destination.country &&
    entry.order.nexus_address.state === entry.order.destination.state,
);

describe("TaxjarApi#calculate_tax_for_order against the Ruby golden", () => {
  it("records the shapes and the answers", () => {
    expect(cases.length).toBeGreaterThan(180);
    expect(golden.length - cases.length).toBe(1);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", async (_name, entry) => {
    const order = toOrder(entry);
    const wire = taxjarWire(order);
    const redis = memory();
    const { fetcher, sent } = stand(entry.http_responses);

    const outcomes = [];
    for (const _ of entry.results)
      outcomes.push(await calculateTaxForOrder(order, { fetch: fetcher, redis: () => redis.client }));

    if (wire === null) {
      // A value Ruby prints differently from JS (an exponent float, an escaped string): nothing is sent, Rails answers.
      expect(sent).toEqual([]);
      expect(outcomes.every((outcome) => outcome.kind === "unsupported")).toBe(true);
      return;
    }

    // Ruby cached a tax it then fails on (a string or null amount, no breakdown): Node hands it back and caches nothing.
    const firstResult = entry.results[0]!;
    if (firstResult.raised === undefined && !usable(firstResult.value)) {
      expect(outcomes[0]!.kind).toBe("unsupported");
      expect(redis.store.size).toBe(0);
      expect(sent[0]!.body).toBe(entry.http[0]!.body);
      return;
    }

    // The request the gem sent: verb, URL, the three headers a port must match, and the JSON body, byte for byte.
    const first = entry.http[0]!;
    expect(sent[0]!.method).toBe(first.method);
    expect(sent[0]!.url).toBe(taxjarEndpoint());
    expect(new URL(first.url).pathname).toBe("/v2/taxes");
    expect(sent[0]!.body).toBe(first.body);
    expect(sent[0]!.headers.authorization).toBe(first.headers["Authorization"]);
    expect(sent[0]!.headers["x-api-version"]).toBe(first.headers["X-Api-Version"]);
    expect(sent[0]!.headers["content-type"]).toBe(first.headers["Content-Type"]);

    // The memo key is Ruby's Hash#to_s of the params, namespaced; both stacks read the same Redis.
    expect(redis.get.mock.calls[0]![0]).toBe(`taxjar_calculations:${wire.cacheKey}`);
    for (const memo of entry.memo) expect(memo.key).toBe(`taxjar_calculations:${wire.cacheKey}`);

    // The outcome per call, and the memo left: written only for an answer Ruby cached, for ten minutes.
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(
      entry.results.map((result) => {
        if (result.raised !== undefined) return FALLBACK_ERRORS.includes(result.raised) ? "fallback" : "unsupported";
        return usable(result.value) ? "tax" : "unsupported";
      }),
    );
    expect(sent).toHaveLength(entry.http.length);
    expect([...redis.store.entries()].map(([key, { ttl }]) => [key, ttl])).toEqual(
      entry.memo.map(({ key, ttl }) => [key, ttl]),
    );
    // What Ruby reads back from the memo is what Ruby wrote, as parsed JSON (10 and 10.0 are the same number to JS).
    if (usable(entry.results[0]!.value)) {
      expect(JSON.parse(redis.store.get(entry.memo[0]!.key)!.value)).toEqual(JSON.parse(entry.memo[0]!.value));
    }
  });
});
