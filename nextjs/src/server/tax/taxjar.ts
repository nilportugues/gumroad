// Port of SalesTaxCalculator#calculate_with_taxjar and TaxjarApi#calculate_tax_for_order (POST /v2/taxes through the
// taxjar-ruby gem, memoised for ten minutes in the `taxjar_calculations` Redis namespace). Only the answers whose
// outcome Rails decides from the status line are modelled; anything else is `unsupported` and left to Rails.
import type { Redis } from "ioredis";

import { getConfig } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";

// Link::NATIVE_TYPES_TO_TAX_CODE
const NATIVE_TYPES_TO_TAX_CODE: Record<string, string | null> = {
  digital: "31000",
  course: "86132000A0002",
  ebook: "31000",
  newsletter: "55111516A0310",
  membership: "55111516A0310",
  podcast: "55111516A0310",
  audiobook: "31000",
  physical: null,
  bundle: "55111500A9220",
  commission: null,
  call: null,
  coffee: null,
};
export const TAXJAR_SAAS_TAX_CODE = "30070";
const SAAS_NATIVE_CODE = "31000";
const API_VERSION = "2022-01-24";
const CACHE_TTL_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 10_000;

// Link#taxjar_product_tax_code; the taxonomy subtree is resolved by the caller (Taxonomy.software_and_plugins_subtree_ids).
export function taxjarProductTaxCode(nativeType: unknown, inSoftwareSubtree: boolean): string | null {
  const code = typeof nativeType === "string" ? (NATIVE_TYPES_TO_TAX_CODE[nativeType] ?? null) : null;
  return code === SAAS_NATIVE_CODE && inSoftwareSubtree ? TAXJAR_SAAS_TAX_CODE : code;
}

export type TaxjarOrder = {
  originCountry: string;
  originState: string;
  originZip: string;
  destinationCountry: string;
  destinationState: string | null;
  destinationZip: string | null;
  quantity: number;
  productTaxCode: string | null;
  unitPriceDollars: number;
  shippingDollars: number;
};

// Float#to_s for the range where it matches JS (Ruby switches to "1.0e-05" below 1e-4 and "1.0e+16" from 1e16).
function rubyFloat(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) return null;
  if (Object.is(value, -0)) return "-0.0";
  const text = String(value);
  return text.includes(".") ? text : `${text}.0`;
}

// Strings that print the same in String#inspect and in ActiveSupport's JSON (which may escape & < >): printable ASCII
// without quote, backslash, `#`, `&`, `<` or `>`.
const plainString = (value: string): boolean => /^[\x20\x21\x24\x25\x27-\x3b\x3d\x3f-\x5b\x5d-\x7e]*$/u.test(value);

type Wire = { json: string; inspect: string };
const wireString = (value: string | null): Wire | null =>
  value === null
    ? { json: "null", inspect: "nil" }
    : plainString(value)
      ? { json: JSON.stringify(value), inspect: JSON.stringify(value) }
      : null;

/** The request body the gem posts and the Ruby `Hash#to_s` that keys the cache, or null for a value Ruby would print differently. */
export function taxjarWire(order: TaxjarOrder): { body: string; cacheKey: string } | null {
  const strings = {
    from_country: wireString(order.originCountry),
    from_state: wireString(order.originState),
    from_zip: wireString(order.originZip),
    to_country: wireString(order.destinationCountry),
    to_state: wireString(order.destinationState),
    to_zip: wireString(order.destinationZip),
    product_tax_code: wireString(order.productTaxCode),
    nexus_country: wireString(order.destinationCountry),
    nexus_state: wireString(order.destinationState),
  };
  const shipping = rubyFloat(order.shippingDollars);
  const unitPrice = rubyFloat(order.unitPriceDollars);
  if (shipping === null || unitPrice === null || Object.values(strings).some((value) => value === null)) return null;
  const s = strings as Record<keyof typeof strings, Wire>;
  const quantity = String(order.quantity);
  const body =
    `{"from_country":${s.from_country.json},"from_state":${s.from_state.json},"from_zip":${s.from_zip.json},` +
    `"to_country":${s.to_country.json},"to_state":${s.to_state.json},"to_zip":${s.to_zip.json},"shipping":${shipping},` +
    `"line_items":[{"quantity":${quantity},"unit_price":${unitPrice},"discount":0,"product_tax_code":${s.product_tax_code.json}}],` +
    `"nexus_addresses":[{"country":${s.nexus_country.json},"state":${s.nexus_state.json}}]}`;
  const cacheKey =
    `{from_country: ${s.from_country.inspect}, from_state: ${s.from_state.inspect}, from_zip: ${s.from_zip.inspect}, ` +
    `to_country: ${s.to_country.inspect}, to_state: ${s.to_state.inspect}, to_zip: ${s.to_zip.inspect}, shipping: ${shipping}, ` +
    `line_items: [{quantity: ${quantity}, unit_price: ${unitPrice}, discount: 0, product_tax_code: ${s.product_tax_code.inspect}}], ` +
    `nexus_addresses: [{country: ${s.nexus_country.inspect}, state: ${s.nexus_state.inspect}}]}`;
  return { body, cacheKey };
}

export type TaxjarOutcome =
  | { kind: "tax"; amountToCollect: number }
  // calculate_with_taxjar returned nil (BadRequest, NotFound, 500, 503): the lookup table decides.
  | { kind: "fallback" }
  | { kind: "unsupported"; reason: string };

export type TaxjarDeps = { fetch?: typeof fetch; redis: () => Redis };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// calculate_with_taxjar reads these keys with `[]` and raises NoMethodError when a section is missing.
function amountToCollect(tax: unknown): number | null {
  if (!isRecord(tax) || !isRecord(tax.breakdown) || !isRecord(tax.jurisdictions)) return null;
  const amount = tax.amount_to_collect;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
}

// TAXJAR_ENDPOINT (config/initializers/taxjar.rb) is the live host in production only; the override lets a replay stand in for TaxJar.
export const taxjarEndpoint = (): string =>
  `${process.env.TAXJAR_ENDPOINT?.trim() || (railsEnv() === "production" ? "https://api.taxjar.com" : "https://api.sandbox.taxjar.com")}/v2/taxes`;

// TaxjarApi#calculate_tax_for_order, then the dollars-to-cents step of calculate_with_taxjar.
export async function calculateTaxForOrder(order: TaxjarOrder, deps: TaxjarDeps): Promise<TaxjarOutcome> {
  const wire = taxjarWire(order);
  if (wire === null) return { kind: "unsupported", reason: "a TaxJar request Ruby would print differently" };

  const redis = deps.redis();
  const key = `taxjar_calculations:${wire.cacheKey}`;
  const cached = await redis.get(key);
  if (cached !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cached);
    } catch {
      return { kind: "unsupported", reason: "an unreadable TaxJar cache entry" };
    }
    const amount = amountToCollect(parsed);
    return amount === null
      ? { kind: "unsupported", reason: "a TaxJar cache entry without a tax breakdown" }
      : { kind: "tax", amountToCollect: amount };
  }

  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(taxjarEndpoint(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${getConfig("TAXJAR_API_KEY") ?? ""}`,
        "x-api-version": API_VERSION,
        "content-type": "application/json; charset=utf-8",
      },
      body: wire.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unsupported", reason: "a TaxJar request that failed before an answer" };
  }

  // BadRequest and NotFound are re-raised without a report, InternalServerError and ServiceUnavailable are in TaxjarErrors::SERVER.
  if ([400, 404, 500, 503].includes(response.status)) return { kind: "fallback" };
  if (response.status !== 200) return { kind: "unsupported", reason: `a TaxJar answer with status ${response.status}` };

  let tax: unknown;
  try {
    tax = (JSON.parse(await response.text()) as { tax?: unknown } | null)?.tax;
  } catch {
    return { kind: "unsupported", reason: "a TaxJar answer that is not JSON" };
  }
  const amount = amountToCollect(tax);
  if (amount === null) return { kind: "unsupported", reason: "a TaxJar answer without a tax breakdown" };
  await redis.set(key, JSON.stringify(tax), "EX", CACHE_TTL_SECONDS);
  return { kind: "tax", amountToCollect: amount };
}

// `(amount_to_collect * 100.0).round`: Float#round is half away from zero.
export const taxjarTaxCents = (amountToCollect: number): number => {
  const cents = amountToCollect * 100;
  return cents < 0 ? -Math.round(-cents) : Math.round(cents);
};
