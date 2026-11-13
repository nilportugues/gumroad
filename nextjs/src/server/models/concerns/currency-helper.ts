// Port of the money half of app/helpers/currency_helper.rb: get_rate / query_rate (the
// `currencies` Redis namespace, refilled from OpenExchangeRates), get_usd_cents,
// usd_cents_to_currency and formatted_dollar_amount. Golden: __fixtures__/currency.golden.json
// (scripts/golden/currency.rb runs the real helper, with CURRENCY_SOURCE on a capture server).
//
// Money is Decimal throughout, as Ruby's BigDecimal; the rate is the Float Ruby parses from its
// Redis string, so the Decimal is that Float's shortest decimal form (BigDecimal(float, 0)).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { rubyFloatToS, rubyToS } from "../../../lib/ruby-to-s.ts";
import { getRedis, namespacedKey } from "../../infra/redis.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../jobs/sidekiq/ruby-json.ts";
import { readCurrencySource } from "../../../worker/jobs/update-currencies-worker.ts";
import LINK_DATA from "../link-data.generated.json" with { type: "json" };

const CURRENCIES = LINK_DATA.currencies as Record<string, { single_unit: boolean }>;

// 60 digits is far past what BigDecimal keeps for any cents amount and rate, so the half-up
// rounding below sees the same digits.
const D = Prisma.Decimal.clone({ precision: 60, rounding: Prisma.Decimal.ROUND_HALF_UP });

// REDIS_TRANSPORT_ERRORS: Redis::BaseError, RedisClient::Error.
export class RedisTransportError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

export class RateUnavailable extends Error {
  readonly rubyClass = "CurrencyHelper::RateUnavailable";
  constructor(currencyType: string) {
    super(`No known ${currencyType} exchange rate and Redis could not be read; refusing to price with a substituted rate.`);
  }
}

export type CurrencyDeps = {
  // $redis
  redis: () => Pick<Redis, "get" | "set">;
  // URI.open(CURRENCY_SOURCE).read
  readSource: () => Promise<string>;
  // Process.clock_gettime(Process::CLOCK_MONOTONIC), in seconds
  monotonicSeconds: () => number;
};

const defaultDeps: CurrencyDeps = {
  redis: () => getRedis("main"),
  readSource: () => readCurrencySource(),
  monotonicSeconds: () => performance.now() / 1000,
};
let deps = defaultDeps;

export function setCurrencyDepsForTesting(next: Partial<CurrencyDeps> | undefined): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  LAST_KNOWN_RATES.clear();
}

// The last rate this process read, per currency, so a Redis stall serves a real rate or fails.
const MAX_RATE_AGE_SECONDS = 3600;
const MAX_REMEMBERED_RATES = 1000;
const LAST_KNOWN_RATES = new Map<string, [string, number]>();

// String#to_f for the strings a rate can be: the leading decimal number, else 0.0.
export function rubyStringToF(value: string): number {
  const match = /^[ \t\n\v\f\r]*[+-]?(?:\d+(?:_\d+)*)?(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?/u.exec(value);
  const text = match?.[0].replaceAll("_", "").trim() ?? "";
  const parsed = Number.parseFloat(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function rememberRate(formattedCurrency: string, rate: string): string {
  if (!(rubyStringToF(rate) > 0)) return rate;
  const observedAt = deps.monotonicSeconds();
  if (LAST_KNOWN_RATES.size < MAX_REMEMBERED_RATES || LAST_KNOWN_RATES.has(formattedCurrency)) LAST_KNOWN_RATES.set(formattedCurrency, [rate, observedAt]);
  return rate;
}

function lastKnownRate(formattedCurrency: string): string | null {
  const remembered = LAST_KNOWN_RATES.get(formattedCurrency);
  if (!remembered) return null;
  const [value, observedAt] = remembered;
  if (deps.monotonicSeconds() - observedAt > MAX_RATE_AGE_SECONDS) return null;
  return rubyStringToF(value) > 0 ? value : null;
}

async function redisCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new RedisTransportError(error);
  }
}

const rateKey = (currency: string) => namespacedKey("currencies", currency);

// currency_namespace.get
const namespaceGet = (currency: string) => redisCall(() => deps.redis().get(rateKey(currency)));

// query_rate: the live document first, whatever fails there falls back to the cached value. A rate
// that is JSON null comes back as nil, not an error.
async function queryRate(currencyType: string): Promise<JsonValue | string | null> {
  try {
    const document = parseRubyJson(await deps.readSource());
    if (document === null || typeof document !== "object" || Array.isArray(document) || document instanceof RubyFloat) throw new TypeError("rates document is not an object");
    const rates = (document as { [key: string]: JsonValue }).rates;
    if (rates === null || rates === undefined || typeof rates !== "object" || Array.isArray(rates) || rates instanceof RubyFloat) throw new TypeError("rates is not an object");
    return (rates as { [key: string]: JsonValue })[currencyType] ?? null;
  } catch {
    return namespaceGet(currencyType);
  }
}

const toS = (value: JsonValue | string | null): string => (typeof value === "string" ? value : rubyToS(value));

// get_rate: a String such as "1.35" (Float#to_s of the rate).
export async function getRate(currencyType: string): Promise<string> {
  if (currencyType === "usd") return "1.0";
  const formatted = currencyType.toUpperCase();
  try {
    const rate = await namespaceGet(formatted);
    if (rate !== null && rubyStringToF(rate) > 0) return rubyFloatToS(rubyStringToF(rememberRate(formatted, rate)));
    const newRate = await queryRate(formatted);
    // redis-rb's #set sends `value.to_s`; nil sends "".
    await redisCall(() => deps.redis().set(rateKey(formatted), toS(newRate)));
    return rubyFloatToS(rubyStringToF(rememberRate(formatted, toS(newRate))));
  } catch (error) {
    if (!(error instanceof RedisTransportError)) throw error;
    const known = lastKnownRate(formatted);
    if (known === null) throw new RateUnavailable(formatted);
    return rubyFloatToS(rubyStringToF(known));
  }
}

// cached_rate: the stored rate only, never a live fetch; a missing, non-positive or unreadable rate is null.
export async function cachedRate(currencyType: string): Promise<string | null> {
  if (currencyType === "usd") return "1.0";
  const formatted = currencyType.toUpperCase();
  try {
    const rate = await namespaceGet(formatted);
    return rate !== null && rubyStringToF(rate) > 0 ? rubyFloatToS(rubyStringToF(rememberRate(formatted, rate))) : null;
  } catch (error) {
    if (error instanceof RedisTransportError) return null;
    throw error;
  }
}

// BigDecimal / 0.0
export class FloatDomainError extends Error {
  readonly rubyClass = "FloatDomainError";
  constructor(quantity: number | bigint) {
    const sign = BigInt(quantity);
    super(sign === 0n ? "Computation results in 'NaN' (Not a Number)" : sign > 0n ? "Computation results in 'Infinity'" : "Computation results in '-Infinity'");
  }
}

// is_currency_type_single_unit?: unknown codes read as usd.
export const isCurrencyTypeSingleUnit = (currencyType: string): boolean => (CURRENCIES[currencyType.toLowerCase()] ?? CURRENCIES.usd!).single_unit;

// `.round` on a BigDecimal: half away from zero, to an Integer.
const roundToInteger = (value: Prisma.Decimal): number => value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();

// unit_scaling_factor
export const unitScalingFactor = (currencyType: string): number => (isCurrencyTypeSingleUnit(currencyType) ? 1 : 100);

// get_usd_cents(currency_type, quantity, rate: nil). `rate` is the Float the rate string parses to.
export async function getUsdCents(currencyType: string, quantity: number | bigint, rate?: number): Promise<number> {
  if (currencyType === "usd") return Number(quantity);
  const conversionRate = rate ?? rubyStringToF(await getRate(currencyType));
  if (conversionRate === 0) throw new FloatDomainError(quantity);
  const converted = new D(quantity.toString()).div(new D(String(conversionRate)));
  return roundToInteger(isCurrencyTypeSingleUnit(currencyType) ? converted.mul(100) : converted);
}

// usd_cents_to_currency with a rate already in hand (`rate.present?`): no lookup, so nothing is awaited.
export function usdCentsToCurrencyAtRate(currencyType: string, quantity: number | bigint, rate: number): number {
  if (currencyType === "usd") return Number(quantity);
  const converted = new D(quantity.toString()).mul(new D(String(rate)));
  return roundToInteger(isCurrencyTypeSingleUnit(currencyType) ? converted.div(100) : converted);
}

// usd_cents_to_currency(currency_type, quantity, rate = nil)
export async function usdCentsToCurrency(currencyType: string, quantity: number | bigint, rate?: number): Promise<number> {
  if (currencyType === "usd") return Number(quantity);
  return usdCentsToCurrencyAtRate(currencyType, quantity, rate ?? rubyStringToF(await getRate(currencyType)));
}

// formatted_dollar_amount: Money.new(cents, "USD").format(with_currency:, no_cents_if_whole:).
export function formattedDollarAmount(amountCents: number | bigint, options: { withCurrency?: boolean; noCentsIfWhole?: boolean } = {}): string {
  const { withCurrency = false, noCentsIfWhole = true } = options;
  const cents = BigInt(amountCents);
  const absolute = cents < 0n ? -cents : cents;
  const dollars = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const remainder = absolute % 100n;
  const fraction = remainder === 0n && noCentsIfWhole ? "" : `.${remainder.toString().padStart(2, "0")}`;
  return `$${cents < 0n ? "-" : ""}${dollars}${fraction}${withCurrency ? " USD" : ""}`;
}
