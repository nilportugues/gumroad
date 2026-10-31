// Port of app/sidekiq/update_currencies_worker.rb (with CURRENCY_SOURCE from
// config/initializers/currency.rb and CurrencyHelper#currency_namespace).
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Redis } from "ioredis";

import { rubyToS } from "../../lib/ruby-to-s.ts";
import { getConfig } from "../../server/infra/config.ts";
import { railsEnv, railsRoot } from "../../server/infra/rails-env.ts";
import { getRedis, namespacedKey } from "../../server/infra/redis.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const OPEN_EXCHANGE_RATES_API_BASE_URL = "https://openexchangerates.org/api";
// open-uri's Net::HTTP gives up after 60s to connect and 60s per read.
const FETCH_TIMEOUT_MS = 120_000;

export function currencySource(): string {
  const env = railsEnv();
  if (env === "development" || env === "test") return path.join(railsRoot(), "lib/currency/backup_rates.json");
  return `${OPEN_EXCHANGE_RATES_API_BASE_URL}/latest.json?app_id=${getConfig("OPEN_EXCHANGE_RATES_APP_ID") ?? ""}`;
}

// URI.open(source).read: open-uri for http(s), a plain file otherwise. Non-2xx raises, as
// OpenURI::HTTPError does.
export async function readCurrencySource(source: string = currencySource()): Promise<string> {
  if (!/^https?:\/\//.test(source)) return readFile(source, "utf8");
  const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

const isHash = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof RubyFloat);

export function updateCurrenciesWorkerWith(deps: { read: () => Promise<string>; redis: () => Pick<Redis, "set"> }): JobHandler {
  return async (args) => {
    checkArity(args, 0);
    const document = parseRubyJson(await deps.read());
    if (!isHash(document)) throw new TypeError("rates document is not a JSON object");
    const rates = Object.hasOwn(document, "rates") ? document.rates! : null;
    if (!isHash(rates)) throw new TypeError(`undefined method 'each' for ${rates === null ? "nil" : typeof rates}`);

    // redis-rb's #set sends `value.to_s`.
    for (const [currency, rate] of Object.entries(rates)) await deps.redis().set(namespacedKey("currencies", currency), rubyToS(rate));
  };
}

export const updateCurrenciesWorker = updateCurrenciesWorkerWith({ read: () => readCurrencySource(), redis: () => getRedis("main") });
