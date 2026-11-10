import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import {
  calculateTaxForOrder,
  taxjarEndpoint,
  taxjarProductTaxCode,
  taxjarTaxCents,
  taxjarWire,
  type TaxjarOrder,
} from "./taxjar.ts";

const order: TaxjarOrder = {
  originCountry: "US",
  originState: "CA",
  originZip: "94104",
  destinationCountry: "US",
  destinationState: "WA",
  destinationZip: "98101",
  quantity: 3,
  productTaxCode: null,
  unitPriceDollars: 1000 / 100 / 3,
  shippingDollars: 10,
};

const taxBody = (amount: unknown) =>
  JSON.stringify({ tax: { amount_to_collect: amount, breakdown: {}, jurisdictions: {} } });

function fakeRedis(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  const set = vi.fn((key: string, value: string) => Promise.resolve(void store.set(key, value)));
  return {
    store,
    set,
    client: { get: (key: string) => Promise.resolve(store.get(key) ?? null), set } as unknown as Redis,
  };
}

describe("taxjarWire", () => {
  it("writes the gem's JSON body and Ruby's Hash#to_s cache key", () => {
    const wire = taxjarWire(order)!;
    expect(wire.body).toBe(
      '{"from_country":"US","from_state":"CA","from_zip":"94104","to_country":"US","to_state":"WA","to_zip":"98101","shipping":10.0,"line_items":[{"quantity":3,"unit_price":3.3333333333333335,"discount":0,"product_tax_code":null}],"nexus_addresses":[{"country":"US","state":"WA"}]}',
    );
    expect(wire.cacheKey).toBe(
      '{from_country: "US", from_state: "CA", from_zip: "94104", to_country: "US", to_state: "WA", to_zip: "98101", shipping: 10.0, line_items: [{quantity: 3, unit_price: 3.3333333333333335, discount: 0, product_tax_code: nil}], nexus_addresses: [{country: "US", state: "WA"}]}',
    );
  });

  it("writes nil for a Canadian buyer's missing zip", () => {
    const wire = taxjarWire({ ...order, destinationCountry: "CA", destinationState: "BC", destinationZip: null })!;
    expect(wire.body).toContain('"to_zip":null');
    expect(wire.cacheKey).toContain("to_zip: nil");
  });

  it.each(['9"8', "98\\1", "a#{b", "a&b", "a<b", "é", "a\nb"])(
    "declines a postal code Ruby would escape: %j",
    (zip) => {
      expect(taxjarWire({ ...order, destinationZip: zip })).toBeNull();
    },
  );

  it.each([0.00001, 1e16, Number.POSITIVE_INFINITY, Number.NaN])(
    "declines a float Ruby prints in another form: %s",
    (price) => {
      expect(taxjarWire({ ...order, unitPriceDollars: price })).toBeNull();
    },
  );

  it("prints a whole float with a fraction digit", () => {
    expect(taxjarWire({ ...order, unitPriceDollars: 20, shippingDollars: 0 })!.body).toContain('"unit_price":20.0');
  });
});

describe("taxjarProductTaxCode", () => {
  it.each([
    ["digital", false, "31000"],
    ["digital", true, "30070"],
    ["ebook", true, "30070"],
    ["course", true, "86132000A0002"],
    ["bundle", false, "55111500A9220"],
    ["membership", false, "55111516A0310"],
    ["physical", false, null],
    ["commission", true, null],
    [null, true, null],
  ])("maps %s (software subtree: %s) to %s", (nativeType, software, code) => {
    expect(taxjarProductTaxCode(nativeType, software)).toBe(code);
  });
});

describe("taxjarTaxCents", () => {
  it("rounds the float the way Float#round does", () => {
    expect(taxjarTaxCents(1.025)).toBe(102);
    expect(taxjarTaxCents(2.99)).toBe(299);
    expect(taxjarTaxCents(0.285)).toBe(28);
  });
});

describe("taxjarEndpoint", () => {
  it("uses the sandbox outside production and honours an override", () => {
    vi.stubEnv("RAILS_ENV", "test");
    vi.stubEnv("TAXJAR_ENDPOINT", "");
    expect(taxjarEndpoint()).toBe("https://api.sandbox.taxjar.com/v2/taxes");
    vi.stubEnv("RAILS_ENV", "production");
    expect(taxjarEndpoint()).toBe("https://api.taxjar.com/v2/taxes");
    vi.stubEnv("TAXJAR_ENDPOINT", "http://127.0.0.1:9");
    expect(taxjarEndpoint()).toBe("http://127.0.0.1:9/v2/taxes");
    vi.unstubAllEnvs();
  });
});

describe("calculateTaxForOrder", () => {
  const respond = (status: number, body = taxBody(1.5)) => vi.fn(() => Promise.resolve(new Response(body, { status })));

  it("posts the order, reads amount_to_collect and caches the tax for ten minutes", async () => {
    const redis = fakeRedis();
    const fetcher = respond(200);
    const outcome = await calculateTaxForOrder(order, { fetch: fetcher, redis: () => redis.client });

    expect(outcome).toEqual({ kind: "tax", amountToCollect: 1.5 });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(taxjarWire(order)!.body);
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json; charset=utf-8");
    expect(redis.set).toHaveBeenCalledWith(
      `taxjar_calculations:${taxjarWire(order)!.cacheKey}`,
      JSON.stringify({ amount_to_collect: 1.5, breakdown: {}, jurisdictions: {} }),
      "EX",
      600,
    );
  });

  it("answers from the cache without calling TaxJar", async () => {
    const redis = fakeRedis({
      [`taxjar_calculations:${taxjarWire(order)!.cacheKey}`]: JSON.stringify({
        amount_to_collect: 2,
        breakdown: {},
        jurisdictions: {},
      }),
    });
    const fetcher = respond(200);
    expect(await calculateTaxForOrder(order, { fetch: fetcher, redis: () => redis.client })).toEqual({
      kind: "tax",
      amountToCollect: 2,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 404, 500, 503])("falls back to the lookup table on a %s and caches nothing", async (status) => {
    const redis = fakeRedis();
    expect(await calculateTaxForOrder(order, { fetch: respond(status), redis: () => redis.client })).toEqual({
      kind: "fallback",
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([401, 403, 422, 429, 502, 504, 302])("leaves a %s to Rails, which reports it or raises", async (status) => {
    const outcome = await calculateTaxForOrder(order, { fetch: respond(status), redis: () => fakeRedis().client });
    expect(outcome.kind).toBe("unsupported");
  });

  it.each([taxBody("1.5"), taxBody(null), "not json", JSON.stringify({ tax: { amount_to_collect: 1 } })])(
    "leaves a 200 Rails would fail on to Rails: %s",
    async (body) => {
      const redis = fakeRedis();
      const outcome = await calculateTaxForOrder(order, { fetch: respond(200, body), redis: () => redis.client });
      expect(outcome.kind).toBe("unsupported");
      expect(redis.set).not.toHaveBeenCalled();
    },
  );

  it("leaves a network failure to Rails", async () => {
    const fetcher = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    expect((await calculateTaxForOrder(order, { fetch: fetcher, redis: () => fakeRedis().client })).kind).toBe(
      "unsupported",
    );
  });
});
