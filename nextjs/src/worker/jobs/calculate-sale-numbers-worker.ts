// Port of app/sidekiq/calculate_sale_numbers_worker.rb: the homepage's total sales (whole dollars) and the number of sellers come from
// one purchase search aggregation and are stored in Redis. Both aggregations are read before either key is written. A sum or
// cardinality in a shape the golden does not cover (a string sum, a sum Ruby would carry past 2**53 as a Float, a boolean or object
// cardinality) hands back before any write, which is safe because the job overwrites both keys from scratch.
// Golden: __fixtures__/calculate-sale-numbers-worker.golden.json (scripts/golden/calculate-sale-numbers-worker.rb).
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { type JsonValue, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { rubyFloatToS } from "../../server/models/concerns/ruby-values.ts";
import { PurchaseSearchService } from "../../server/search/purchase-search.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const TOTAL_MADE_KEY = "homepage:total_made";
const NUMBER_OF_CREATORS_KEY = "company_page:number_of_creators";
const CARDINALITY_PRECISION_THRESHOLD = 40_000; // Elasticsearch's maximum
const CENTS_PER_DOLLAR = 100n;

type SaleNumbersRedis = { set(key: string, value: string): Promise<unknown> };
export type CalculateSaleNumbersDeps = { redis: () => SaleNumbersRedis };

class RubyNoMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMethodError";
  }
}

// `aggregations.<name>.value`: a missing aggregation is nil and fails on `.value`; a missing value is nil.
function aggregationValue(aggregations: Record<string, unknown> | undefined, name: string): JsonValue | undefined {
  const aggregation = aggregations?.[name];
  if (aggregation === undefined || aggregation === null)
    throw new RubyNoMethodError("undefined method 'value' for nil");
  if (typeof aggregation !== "object" || Array.isArray(aggregation))
    throw new HandBackToRuby(`${name} is not an aggregation`);
  return (aggregation as Record<string, JsonValue>).value;
}

// `value.to_i / 100`: nil is 0, a Float truncates, Integer division floors.
function wholeDollars(value: JsonValue | undefined): bigint {
  let cents: bigint;
  if (value === undefined || value === null) cents = 0n;
  else if (typeof value === "bigint") cents = value;
  else if (typeof value === "number" || value instanceof RubyFloat) {
    const raw = typeof value === "number" ? value : value.value;
    if (!Number.isFinite(raw) || Math.abs(raw) > Number.MAX_SAFE_INTEGER)
      throw new HandBackToRuby("the sum is too large for a Float to carry exactly");
    cents = BigInt(Math.trunc(raw));
  } else throw new HandBackToRuby("the sum is not a number");
  const quotient = cents / CENTS_PER_DOLLAR;
  return cents % CENTS_PER_DOLLAR < 0n ? quotient - 1n : quotient;
}

// `$redis.set(key, value)` stores `value.to_s`.
function storedCardinality(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "bigint" || typeof value === "string") return String(value);
  if (value instanceof RubyFloat) return rubyFloatToS(value.value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : rubyFloatToS(value);
  throw new HandBackToRuby("the number of sellers is not a number");
}

export const calculateSaleNumbersWorkerWith = (
  deps: Partial<JobDeps> = {},
  numbers: Partial<CalculateSaleNumbersDeps> = {},
) =>
  modelJob({ min: 0 }, async () => {
    const result = await PurchaseSearchService.process({
      price_greater_than: 0,
      state: "successful",
      size: 0,
      exclude_unreversed_chargedback: true,
      exclude_refunded: true,
      exclude_bundle_product_purchases: true,
      aggs: {
        total_made: { sum: { field: "price_cents" } },
        number_of_creators: {
          cardinality: { field: "seller_id", precision_threshold: CARDINALITY_PRECISION_THRESHOLD },
        },
      },
    });
    const aggregations = result.response.aggregations;
    const totalMade = wholeDollars(aggregationValue(aggregations, "total_made"));
    const numberOfCreators = storedCardinality(aggregationValue(aggregations, "number_of_creators"));

    const redis = (numbers.redis ?? (() => getRedis("main")))();
    await redis.set(TOTAL_MADE_KEY, totalMade.toString());
    await redis.set(NUMBER_OF_CREATORS_KEY, numberOfCreators);
  })(deps);

export const calculateSaleNumbersWorker = calculateSaleNumbersWorkerWith();
