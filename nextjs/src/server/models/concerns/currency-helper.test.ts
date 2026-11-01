// Replays __fixtures__/currency.golden.json (scripts/golden/currency.rb): the real CurrencyHelper,
// with CURRENCY_SOURCE on a capture server. The OpenExchangeRates request goes to a local HTTP
// server here too, so what is compared is the request fetch sends, not a stub's call count.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseRubyJson, RubyFloat } from "../../jobs/sidekiq/ruby-json.ts";
import { readCurrencySource } from "../../../worker/jobs/update-currencies-worker.ts";
import { formattedDollarAmount, getRate, getUsdCents, setCurrencyDepsForTesting, usdCentsToCurrency } from "./currency-helper.ts";

type Step = { call: [string, ...unknown[]]; redis?: Record<string, string>; down?: boolean; http?: [number, Record<string, string>, string][] };
type Result = { value?: unknown; error?: { class: string; message: string }; http: { method: string; path: string; query: string | null }[] };
type Case = { name: string; steps: Step[]; results: Result[]; redis: Record<string, { value?: unknown }> };
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/currency.golden.json", import.meta.url), "utf8")) as unknown as {
  cases: Case[];
  vectors: { currency: string; quantity: number; rate: RubyFloat; usd_cents: number; to_currency: number }[];
  formatting: { cents: number; options: { with_currency?: boolean; no_cents_if_whole?: boolean }; formatted: string }[];
};

let server: Server;
let scripted: [number, Record<string, string>, string][] = [];
let requests: { method: string; path: string; query: string | null }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const [path, ...query] = (request.url ?? "").split("?");
    requests.push({ method: request.method ?? "", path: path!, query: query.length ? query.join("?") : null });
    const [status, headers, body] = scripted.shift() ?? [500, {}, "no scripted response"];
    response.writeHead(status, headers);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const rubyValue = (value: unknown) => (value instanceof RubyFloat ? value.value : value);

function fakeRedis(initial: Record<string, string>, step: () => Step) {
  const store = new Map(Object.entries(initial));
  const guard = () => {
    if (step().down) throw new Error("Connection refused");
  };
  return {
    store,
    redis: {
      get: async (key: string) => (guard(), store.get(key) ?? null),
      set: async (key: string, value: string) => (guard(), void store.set(key, value), "OK"),
    },
  };
}

describe("CurrencyHelper", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      let current: Step = c.steps[0]!;
      const { redis, store } = fakeRedis({}, () => current);
      const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/latest.json?app_id=golden`;
      setCurrencyDepsForTesting({ redis: () => redis as never, readSource: () => readCurrencySource(url()) });
      const actual: Result[] = [];
      for (const step of c.steps) {
        current = step;
        for (const [key, value] of Object.entries(step.redis ?? {})) store.set(key, value);
        requests = [];
        scripted = [...(step.http ?? [])];
        const [method, ...args] = step.call;
        const result: Result = { http: [] };
        try {
          const last = args.at(-1);
          const rate = last !== null && typeof last === "object" && !(last instanceof RubyFloat) ? (args.pop() as { rate: RubyFloat }) : undefined;
          const positional = args.map(rubyValue);
          if (method === "get_rate") result.value = await getRate(positional[0] as string);
          else if (method === "get_usd_cents") result.value = await getUsdCents(positional[0] as string, positional[1] as number, rate ? rubyValue(rate.rate) as number : undefined);
          else result.value = await usdCentsToCurrency(positional[0] as string, positional[1] as number, positional[2] as number | undefined);
        } catch (error) {
          result.error = { class: (error as { rubyClass?: string }).rubyClass ?? (error as Error).name, message: (error as Error).message };
        }
        result.http = requests;
        actual.push(result);
      }
      expect(actual).toEqual(
        c.results.map((r) => ({ ...(r.error ? { error: r.error } : { value: r.value }), http: r.http })),
      );
      expect(Object.fromEntries([...store].filter(([key]) => key.startsWith("currencies:")))).toEqual(
        Object.fromEntries(Object.entries(c.redis).filter(([key]) => key.startsWith("currencies:")).map(([key, v]) => [key, v.value])),
      );
    });
  }

  it("converts like BigDecimal for every recorded rate and amount", async () => {
    for (const v of golden.vectors) {
      const rate = rubyValue(v.rate) as number;
      expect(await getUsdCents(v.currency, v.quantity, rate), `${v.quantity} ${v.currency} @ ${rate}`).toBe(v.usd_cents);
      expect(await usdCentsToCurrency(v.currency, v.quantity, rate), `${v.quantity} ${v.currency} @ ${rate} to`).toBe(v.to_currency);
    }
  });

  it("formats dollar amounts like Money", () => {
    for (const f of golden.formatting) {
      expect(formattedDollarAmount(f.cents, { withCurrency: f.options.with_currency, noCentsIfWhole: f.options.no_cents_if_whole })).toBe(f.formatted);
    }
  });
});
