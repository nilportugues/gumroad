import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { contextFor, golden, goldenRuntime, recordingSidekiqRedis } from "./__fixtures__/golden.ts";
import { currencySource, readCurrencySource, updateCurrenciesWorkerWith } from "./update-currencies-worker.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("UpdateCurrenciesWorker matches the Ruby job", () => {
  it.each(golden.update_currencies_worker.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const writes: [string, string][] = [];
    const handler = updateCurrenciesWorkerWith({
      read: async () => c.body,
      redis: () => ({ set: async (key: string, value: string) => (writes.push([key, value]), "OK") }) as never,
    });
    const run = handler([], contextFor(goldenRuntime(recordingSidekiqRedis().redis)));
    if (c.error) await expect(run).rejects.toThrow();
    else await run;
    expect(writes).toEqual(c.writes);
  });
});

describe("currencySource", () => {
  it("reads the bundled backup rates in development and test", () => {
    vi.stubEnv("RAILS_ENV", "test");
    vi.stubEnv("RAILS_ROOT", "/app");
    expect(currencySource()).toBe("/app/lib/currency/backup_rates.json");
  });

  it("calls Open Exchange Rates elsewhere", () => {
    vi.stubEnv("RAILS_ENV", "production");
    vi.stubEnv("OPEN_EXCHANGE_RATES_APP_ID", "key");
    expect(currencySource()).toBe("https://openexchangerates.org/api/latest.json?app_id=key");
  });
});

describe("readCurrencySource", () => {
  it("reads a local file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rates-"));
    try {
      writeFileSync(path.join(dir, "rates.json"), '{"rates":{}}');
      await expect(readCurrencySource(path.join(dir, "rates.json"))).resolves.toBe('{"rates":{}}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("raises on a non-2xx response, as open-uri does", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401, statusText: "Unauthorized" })));
    await expect(readCurrencySource("https://openexchangerates.org/api/latest.json?app_id=")).rejects.toThrow("401 Unauthorized");
  });

  it("returns the body of a successful response", async () => {
    const fetchMock = vi.fn(async () => new Response('{"rates":{"USD":1}}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readCurrencySource("https://openexchangerates.org/api/latest.json?app_id=k")).resolves.toBe('{"rates":{"USD":1}}');
    expect(fetchMock).toHaveBeenCalledWith("https://openexchangerates.org/api/latest.json?app_id=k", expect.anything());
  });
});
