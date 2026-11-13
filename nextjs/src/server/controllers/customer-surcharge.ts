// Port of app/controllers/customer_surcharge_controller.rb#calculate_all (POST /customer_surcharge) for the carts whose
// answer needs no Rails-only state: no seller in the buyer-currency rollout, so the response carries no FX quote and no
// direct-listed token. A US taxable state or a Canadian province is taxed through TaxJar (`tax/taxjar.ts`, cached in the
// same Redis namespace as Rails); a VAT id is checked here when its validator is local (Bahrain, Kenya, Nigeria,
// Tanzania, Oman), IRAS, Revenu Quebec or taxid.pro (memoised in the Rails.cache key Ruby uses), Vatstack (ABN, MVA) or VIES.
//
// Physical lines are served through their ShippingDestination (exact country, then ELSEWHERE). A preorder line
// (nothing charged now), a membership line (charged like a one-time line) and an installment line (the first payment,
// taxed on its own) are served too; only their `charge_canonical_total_cents` differs from the one-time arithmetic.
//
// Everything else hands back to Rails before anything is written (nothing here writes): a commission line (deposit
// split, completion surcharges, once-per-cart codes), a subscription renewal, a VAT id answered in a way Ruby raises on or
// reads through a parser Node does not model, a TaxJar answer outside the
// 200/400/404/500/503 cases, a Payment Element or list-token request, a seller with
// `buyer_currency_charging` on, a Singapore rate table whose `applicable_years` is not plain, a Spanish buyer the GeoIP database
// places in the Canary Islands, a bundle with a component whose product row is gone, a missing `products` (ParameterMissing is rendered by the exceptions
// app) and a request whose format is neither html, json nor a registered `format` param (the content type of `head`). The 400 (malformed `products`) and
// 503 (RateUnavailable) answers are served: an empty body typed by the request format.
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";

import { detectedBuyerCurrency } from "../infra/buyer-currency-countries.ts";
import { getConfig } from "../infra/config.ts";
import { CONTINENT_SHIPPING_COUNTRIES } from "../infra/continent-shipping-countries.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { geoIpLookup } from "../infra/geo-ip.ts";
import { getNamespacedRedis } from "../infra/redis.ts";
import { getRate, getUsdCents, RateUnavailable, rubyStringToF } from "../models/concerns/currency-helper.ts";
import { LinkFlags } from "../models/link.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { jsonDataForAttr, Users } from "../models/user.ts";
import { hasBrazilianStripeConnectAccount } from "../page-props/dashboard/payout-info.ts";
import { findUserById, type LinkRow } from "../presenters/product-reads.ts";
import { castBoolean } from "../search/ruby-params.ts";
import {
  calculateWithLookup,
  chargeCanonicalTotalCents,
  surchargeTotals,
  validProductsParam,
  type SurchargeLine,
} from "../tax/customer-surcharge.ts";
import { regionalVatIdValidator } from "../tax/regional-vat-id-shape.ts";
import {
  buyerTaxRegion,
  esVatExemptWithoutGeoIp,
  taxEligible,
  type BuyerLocation,
  zeroBusinessVat,
  zeroTax,
  type SalesTaxCalculation,
} from "../tax/sales-tax-calculation.ts";
import {
  COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
  COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS,
  EU_VAT_APPLICABLE_COUNTRY_CODES,
  EU_VAT_DESTINATION_COUNTRY_CODES,
} from "../tax/sales-tax-countries.ts";
import { calculateTaxForOrder, taxjarProductTaxCode, taxjarTaxCents } from "../tax/taxjar.ts";
import { validateVendorTaxId } from "../tax/vendor-tax-id.ts";
import { validateViesVatId } from "../tax/vies-vat-id.ts";

import { HandBackToRails, type ActionResult, type Rendered } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, remoteIp, type MutationInput } from "./mutation.ts";
import { queryParam } from "./rails-request.ts";
import { requestFormat } from "./signed-in-filters.ts";

type Row = Record<string, unknown>;

// config/currencies.json: CURRENCY_CHOICES["usd"][:display_format]
const USD_LABEL = "$ (US Dollars)";
const BUYER_CURRENCY_FEATURE = "buyer_currency_charging";
const BUYER_LOCAL_CURRENCY_FEATURE = "buyer_local_currency";
// Countries with their own e-publication ZipTaxRate row in the lookup table (Salestax#calculate_with_lookup_table).
const SPECIAL_EPUBLICATION_COUNTRIES = ["IS", "CH", "MX"];
const SELLER_RESPONSIBLE_FLAG = 1;
const EPUBLICATION_RATE_FLAG = 2;

const VIRTUAL_COUNTRY_FLAG = 1;
const ELSEWHERE = "ELSEWHERE";
// Subdivision iso codes of the Canary Islands autonomous community and its two provinces.
const CANARY_REGION_CODES = ["CN", "TF", "GC"];
const SOFTWARE_AND_PLUGINS_SLUG = "software-and-plugins";

const handBack = (reason: string): never => {
  throw new HandBackToRails(`customer_surcharge ${reason}`);
};

// `value.blank?` for the strings a param can carry.
const blank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && /^[\s\u0085]*$/u.test(value));

// A param Rails reads as a String (or nil): any other JSON type is Ruby's to interpret.
function textParam(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return handBack(`with a non-string ${name}`);
  return value;
}

// `item[:price].to_d.to_i`: a number truncates, a string reads its leading integer and is 0 without one.
function submittedPriceCents(value: unknown): number {
  if (typeof value === "number") {
    const cents = Math.trunc(value);
    return Number.isSafeInteger(cents) ? cents : handBack("with an oversized price");
  }
  if (typeof value !== "string") return handBack("with a price that is not a number or string");
  // BigDecimal reads a bare fraction, exponents and underscores, which this scan would cut short.
  if (/^\s*[+-]?\./u.test(value) || /^\s*[+-]?\d+(?:\.\d+)?[eE_]/u.test(value)) return handBack("with an exotic price");
  const match = /^\s*([+-]?\d+)/u.exec(value);
  if (match === null) return 0;
  const cents = Number(match[1]);
  return Number.isSafeInteger(cents) ? cents : handBack("with an oversized price");
}

// `item[:tip_cents].to_i` for a String or Numeric, 0 for anything else (from_surcharge and buyer_currency_charge_details).
function tipCents(value: unknown): number {
  if (typeof value === "number") {
    const cents = Math.trunc(value);
    return Number.isSafeInteger(cents) ? cents : handBack("with an oversized tip");
  }
  if (typeof value !== "string") return 0;
  // String#to_i reads digit-separating underscores, which this scan would cut short.
  if (/^\s*[+-]?\d+_/u.test(value)) return handBack("with an exotic tip");
  const match = /^\s*([+-]?\d+)/u.exec(value);
  if (match === null) return 0;
  const cents = Number(match[1]);
  return Number.isSafeInteger(cents) ? cents : handBack("with an oversized tip");
}

// `product.installment_plan` (has_one, alive): the number of installments.
async function installmentCount(linkId: bigint): Promise<bigint | null> {
  const [row] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`product_installment_plans`.*")} FROM ${table("product_installment_plans")} WHERE ${column("product_installment_plans", "link_id")} = ${linkId} AND ${column("product_installment_plans", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (row === undefined) return null;
  const count = BigInt(String(row.number_of_installments));
  return count > 1n ? count : handBack("for an installment plan with fewer than two installments");
}

// Link.find_by_unique_permalink
async function findLinkByPermalink(permalink: string): Promise<LinkRow | null> {
  const [row] = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
  );
  return row ?? null;
}

const flagSet = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]): boolean =>
  LinkFlags.isSet(row.flags, name);

// ZipTaxRate.alive.not_is_seller_responsible, narrowed by country, state and the e-publication flag; `.first` orders by id.
async function firstZipTaxRate(
  country: string,
  options: { state?: string | null; epublication?: boolean } = {},
): Promise<Row | null> {
  const conditions = [
    Prisma.sql`${column("zip_tax_rates", "deleted_at")} IS NULL`,
    Prisma.sql`${column("zip_tax_rates", "country")} = ${country}`,
    Prisma.sql`(${column("zip_tax_rates", "flags")} & ${SELLER_RESPONSIBLE_FLAG}) = 0`,
  ];
  if (options.state !== undefined) {
    conditions.push(
      options.state === null
        ? Prisma.sql`${column("zip_tax_rates", "state")} IS NULL`
        : Prisma.sql`${column("zip_tax_rates", "state")} = ${options.state}`,
    );
  }
  if (options.epublication !== undefined) {
    conditions.push(
      Prisma.sql`(${column("zip_tax_rates", "flags")} & ${EPUBLICATION_RATE_FLAG}) ${options.epublication ? Prisma.sql`!= 0` : Prisma.sql`= 0`}`,
    );
  }
  const [row] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`zip_tax_rates`.*")} FROM ${table("zip_tax_rates")} WHERE ${Prisma.join(conditions, " AND ")} ORDER BY ${column("zip_tax_rates", "id")} ASC LIMIT 1`,
  );
  return row ?? null;
}

// `rate.applicable_years` (attr_json_data_accessor over the JSON-coded json_data); Ruby raises on a missing list.
function applicableYears(row: Row): number[] {
  let years: unknown;
  try {
    years = (JSON.parse(String(row.json_data)) as { applicable_years?: unknown } | null)?.applicable_years;
  } catch {
    return handBack("for a Singapore rate with unreadable json_data");
  }
  if (!Array.isArray(years) || !years.every((year) => Number.isSafeInteger(year))) {
    return handBack("for a Singapore rate without a plain applicable_years list");
  }
  return years as number[];
}

// SalesTaxCalculator#calculate_with_lookup_table, Singapore: the rate listing the current year, else the one with the
// latest year (`sort_by` is unstable, so ties beyond two rates are not served).
async function singaporeRate(): Promise<Row | null> {
  const rates = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`zip_tax_rates`.*")} FROM ${table("zip_tax_rates")} WHERE ${column("zip_tax_rates", "deleted_at")} IS NULL AND ${column("zip_tax_rates", "country")} = ${"SG"} AND (${column("zip_tax_rates", "flags")} & ${SELLER_RESPONSIBLE_FLAG}) = 0 AND (${column("zip_tax_rates", "flags")} & ${EPUBLICATION_RATE_FLAG}) = 0 ORDER BY ${column("zip_tax_rates", "created_at")} ASC, ${column("zip_tax_rates", "id")} ASC`,
  );
  const year = new Date().getUTCFullYear();
  // Rails calls `applicable_years.include?` on each rate until one matches and raises on a rate with no years (nil).
  for (const rate of rates) {
    const years = applicableYears(rate);
    if (years.length === 0) return handBack("for a Singapore rate with no applicable years");
    if (years.includes(year)) return rate;
  }
  if (rates.length <= 1) return rates[0] ?? null;
  const latest = rates.map((rate) => Math.max(...applicableYears(rate)));
  const best = Math.max(...latest);
  const tied = latest.filter((value) => value === best).length > 1;
  // A tie is only decided for two rates: sort_by keeps a two-element input in order, so `.last` is the later-created.
  if (tied) return rates.length === 2 ? (rates[1] ?? null) : handBack("for Singapore rates tied on their latest year");
  return rates[latest.indexOf(best)] ?? null;
}

// SalesTaxCalculator#calculate_with_lookup_table (the rows a TaxJar buyer falls back to when TaxJar cannot answer).
async function lookupRate(
  link: LinkRow,
  location: BuyerLocation,
  state: string | null,
  isUsTaxableState: boolean,
): Promise<Row | null> {
  const country = location.country;
  if (blank(country)) return null;
  const code = country!;
  const epublication = flagSet(link, "is_epublication");

  if (isUsTaxableState) return firstZipTaxRate("US", { state, epublication: false });

  if (EU_VAT_APPLICABLE_COUNTRY_CODES.includes(code) || code === "NO") return firstZipTaxRate(code, { epublication });
  if (code === "AU") return firstZipTaxRate(code, { epublication: false });
  if (code === "SG") return singaporeRate();
  if (code === "CA") return firstZipTaxRate(code, { state, epublication: false });

  const collects =
    COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS.includes(code) ||
    COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS.includes(code);
  if (!(await isFeatureEnabled(`collect_tax_${code.toLowerCase()}`)) || !collects) return null;
  return firstZipTaxRate(code, SPECIAL_EPUBLICATION_COUNTRIES.includes(code) ? { epublication } : {});
}

// The GeoIP leg of `is_vat_exempt?`: a Spanish IP in a subdivision named like the Canary Islands. The lookup keeps only
// the last subdivision's iso code, so a Canary region (or an unknown one) is left to Rails.
function esExemptByGeoIp(ip: string | null): boolean {
  const geocode = geoIpLookup(ip);
  if (geocode === null || geocode.countryCode !== "ES") return false;
  if (geocode.regionName === null || CANARY_REGION_CODES.includes(geocode.regionName)) {
    return handBack("for a Spanish rate and a buyer IP in the Canary Islands or an unnamed region");
  }
  return false;
}

// SalesTaxCalculator#entirely_physical_shipment? for a bundle: its live components decide, and a mixed or empty bundle keeps
// collecting. A component whose product row is gone is Ruby's NoMethodError, so that case is Rails' to answer.
async function bundleEntirelyPhysical(bundleId: unknown): Promise<boolean> {
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT ${column("links", "id")} AS product_id, ${column("links", "flags")} AS flags FROM ${table("bundle_products")} LEFT JOIN ${table("links")} ON ${column("links", "id")} = ${column("bundle_products", "product_id")} WHERE ${column("bundle_products", "bundle_id")} = ${bundleId} AND ${column("bundle_products", "deleted_at")} IS NULL`,
  );
  if (rows.some((row) => row.product_id === null || row.product_id === undefined)) {
    return handBack("for a bundle with a component whose product is gone");
  }
  return rows.length > 0 && rows.every((row) => flagSet({ flags: row.flags } as LinkRow, "is_physical"));
}

// Taxonomy.software_and_plugins_subtree_ids.include?(link.taxonomy_id)
async function inSoftwareSubtree(link: LinkRow): Promise<boolean> {
  if (link.taxonomy_id === null || link.taxonomy_id === undefined) return false;
  const [row] = await selectRows<Row>(
    Prisma.sql`SELECT 1 AS found FROM ${table("taxonomies")} INNER JOIN ${table("taxonomy_hierarchies")} ON ${column("taxonomy_hierarchies", "ancestor_id")} = ${column("taxonomies", "id")} WHERE ${column("taxonomies", "slug")} = ${SOFTWARE_AND_PLUGINS_SLUG} AND ${column("taxonomy_hierarchies", "descendant_id")} = ${link.taxonomy_id} LIMIT 1`,
  );
  return row !== undefined;
}

// The quantity in `unit_price_dollars = price_cents / 100.0 / quantity`: a nil, zero or fractional one is a Ruby error or
// an Infinity in the request body, so only a positive integer is served.
function taxjarQuantity(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const match = typeof value === "string" ? /^\s*\+?(\d+)\s*$/u.exec(value) : null;
  const quantity = match?.[1] === undefined ? 0 : Number(match[1]);
  return Number.isSafeInteger(quantity) && quantity > 0
    ? quantity
    : handBack("for a TaxJar buyer with a quantity that is not a positive integer");
}

export type TaxContext = {
  /** The line's shipping in USD cents, as `calculate_surcharges` passes it to the calculator. */
  shippingCents?: number;
  /** `item[:quantity]` as submitted. */
  quantity?: unknown;
  /** `params[:vat_id].presence` */
  vatId?: string | null;
};

// SalesTaxCalculator#is_vat_id_valid?: the offline validators, IRAS, Revenu Quebec, taxid.pro and Vatstack (`tax/vendor-tax-id.ts`),
// and VIES through valvat (`tax/vies-vat-id.ts`).
async function vatIdValid(vatId: string, location: BuyerLocation, state: string | null): Promise<boolean> {
  const validator = regionalVatIdValidator(location.country, state);
  if (validator.kind === "local") return validator.validate(vatId);
  const { service } = validator;
  const outcome =
    service === "VatValidationService"
      ? await validateViesVatId(vatId)
      : await validateVendorTaxId(service, vatId, location.country);
  return outcome.kind === "valid" ? outcome.valid : handBack(`for a VAT id answered as ${outcome.reason}`);
}

// SalesTaxCalculator#calculate_with_taxjar. Null is Rails' `return` after a TaxJar client or server error.
async function calculateWithTaxjar(
  link: LinkRow,
  priceCents: number,
  location: BuyerLocation,
  state: string | null,
  context: TaxContext,
): Promise<number | null> {
  const quantity = taxjarQuantity(context.quantity);
  const outcome = await calculateTaxForOrder(
    {
      originCountry: getConfig("ADDRESS_COUNTRY", "US").toUpperCase(),
      originState: getConfig("ADDRESS_STATE", "CA"),
      originZip: getConfig("ADDRESS_ZIP", "94104"),
      destinationCountry: location.country!,
      destinationState: state,
      destinationZip: location.country === "US" ? (location.postal_code ?? null) : null,
      quantity,
      productTaxCode: taxjarProductTaxCode(link.native_type, await inSoftwareSubtree(link)),
      unitPriceDollars: priceCents / 100 / quantity,
      shippingDollars: (context.shippingCents ?? 0) / 100,
    },
    { redis: () => getNamespacedRedis("taxjar_calculations") },
  );
  if (outcome.kind === "unsupported") return handBack(`for ${outcome.reason}`);
  return outcome.kind === "tax" ? taxjarTaxCents(outcome.amountToCollect) : null;
}

// SalesTaxCalculator#calculate: a valid tax id, TaxJar for a US taxable state or a Canadian province, else the lookup table.
export async function calculateSalesTax(
  link: LinkRow,
  priceCents: number,
  location: BuyerLocation,
  ip: string | null = null,
  context: TaxContext = {},
): Promise<SalesTaxCalculation> {
  const region = buyerTaxRegion(location);
  const sellerId = link.user_id;
  if (priceCents === 0) return zeroTax(priceCents);
  if (sellerId !== null && (await hasBrazilianStripeConnectAccount(sellerId))) return zeroTax(priceCents);
  const vatId = blank(context.vatId) ? null : context.vatId!;
  if (vatId !== null && (await vatIdValid(vatId, location, region.state))) return zeroBusinessVat(priceCents);
  if (region.isUsTaxableState || region.isCaTaxable) {
    const taxCents = await calculateWithTaxjar(link, priceCents, location, region.state, context);
    if (taxCents !== null) {
      return {
        priceCents,
        taxCents,
        zipTaxRateCountry: null,
        businessVatStatus: vatId === null ? null : "invalid",
        isQuebec: region.isQuebec,
      };
    }
  }

  const isPhysical = flagSet(link, "is_physical");
  const row = await lookupRate(link, location, region.state, region.isUsTaxableState);
  let rate: { country: string; combinedRate: string } | null = null;
  let eligible = false;
  if (row !== null) {
    const country = String(row.country);
    // is_vat_exempt?: only Spain's rows can be exempt.
    const exempt = esVatExemptWithoutGeoIp(country, location) ?? esExemptByGeoIp(ip);
    if (!exempt) {
      rate = { country, combinedRate: new Prisma.Decimal(row.combined_rate as never).toFixed(7) };
      const flag = `collect_tax_${country.toLowerCase()}`;
      const flagActive = await isFeatureEnabled(flag);
      // Rails asks `entirely_physical_shipment?` last, and only for a destination rate that is not the seller's own.
      const bundleBoundForEu =
        flagSet(link, "is_bundle") &&
        !(row.user_id !== null && row.user_id !== undefined) &&
        EU_VAT_DESTINATION_COUNTRY_CODES.includes(country);
      const entirelyPhysical = bundleBoundForEu ? await bundleEntirelyPhysical(link.id) : isPhysical;
      eligible = taxEligible({
        rateCountry: country,
        rateIsSellerOwn: row.user_id !== null && row.user_id !== undefined,
        isPhysical,
        region,
        featureActive: (name) => name === flag && flagActive,
        entirelyPhysicalShipment: () => entirelyPhysical,
      });
    }
  }
  return calculateWithLookup({
    priceCents,
    buyerVatIdPresent: vatId !== null,
    vatIdValid: false,
    sellerHasBrazilianConnectAccount: false,
    rate,
    taxEligible: eligible,
    isQuebec: false,
  });
}

// `quantity.to_i` for the values a cart sends; anything Ruby would fail on or read fractionally is its to answer.
function shippingQuantity(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  const match = typeof value === "string" ? /^\s*([+-]?\d+)\s*$/u.exec(value) : null;
  if (match?.[1] === undefined) return handBack("with a quantity that is not an integer");
  return BigInt(match[1]);
}

// ShippingDestination::Destinations.virtual_countries_for_country_code
export const virtualCountriesFor = (country: string): string[] =>
  Object.entries(CONTINENT_SHIPPING_COUNTRIES)
    .filter(([, countries]) => countries.includes(country))
    .map(([continent]) => continent);

// ShippingDestination.for_product_and_country_code for a physical product: the buyer's country, else ELSEWHERE.
// A continent destination (EUROPE, ASIA, NORTH AMERICA) serves the countries Destinations lists for it.
async function shippingDestinationFor(link: LinkRow, country: string): Promise<Row | null> {
  const [excluded] = await selectRows<Row>(
    Prisma.sql`SELECT 1 AS excluded FROM ${table("shipping_exclusions")} WHERE ${column("shipping_exclusions", "product_id")} = ${link.id} AND ${column("shipping_exclusions", "country_code")} = ${country} LIMIT 1`,
  );
  if (excluded !== undefined) return null;

  const alive = Prisma.sql`${column("shipping_destinations", "link_id")} = ${link.id} AND ${column("shipping_destinations", "deleted_at")} IS NULL`;
  const first = async (condition: Prisma.Sql): Promise<Row | null> => {
    const [row] = await selectRows<Row>(
      Prisma.sql`SELECT ${Prisma.raw("`shipping_destinations`.*")} FROM ${table("shipping_destinations")} WHERE ${alive} AND ${condition} ORDER BY ${column("shipping_destinations", "id")} ASC LIMIT 1`,
    );
    return row ?? null;
  };

  const exact = await first(Prisma.sql`${column("shipping_destinations", "country_code")} = ${country}`);
  if (exact !== null) return exact;
  const continents = virtualCountriesFor(country);
  if (continents.length > 0) {
    const virtual = await first(
      Prisma.sql`(${column("shipping_destinations", "flags")} & ${VIRTUAL_COUNTRY_FLAG}) != 0 AND ${column("shipping_destinations", "country_code")} IN (${Prisma.join(continents)})`,
    );
    if (virtual !== null) return virtual;
  }
  return first(Prisma.sql`${column("shipping_destinations", "country_code")} = ${ELSEWHERE}`);
}

// CustomerSurchargeController#calculate_surcharges' shipping: ShippingDestination#calculate_shipping_rate in USD cents.
async function shippingUsdCents(
  link: LinkRow,
  country: string | null,
  quantityParam: unknown,
  rate: number | undefined,
): Promise<number> {
  if (country === null) return 0;
  const destination = await shippingDestinationFor(link, country);
  if (destination === null) return 0;

  const quantity = shippingQuantity(quantityParam);
  if (quantity < 1n) return 0;
  const currencyType = String(link.price_currency_type);
  if (rate === 0) return handBack("with a zero exchange rate");
  const oneItem = BigInt(String(destination.one_item_rate_cents));
  const multipleItems = BigInt(String(destination.multiple_items_rate_cents));
  return (
    (await getUsdCents(currencyType, oneItem, rate)) +
    (await getUsdCents(currencyType, multipleItems * (quantity - 1n), rate))
  );
}

// Checkout::BuyerCurrencyEligibility.seller_enabled?
async function sellerEnabled(sellerId: bigint): Promise<boolean> {
  const seller = await findUserById(sellerId);
  if (seller === null) return false;
  const actor = userActor(sellerId);
  if (!(await isFeatureEnabled(BUYER_CURRENCY_FEATURE, actor))) return false;
  if (!(await isFeatureEnabled(BUYER_LOCAL_CURRENCY_FEATURE, actor))) return false;
  const record = Users.load(castRow<User>("User", seller as never));
  return castBoolean(jsonDataForAttr(record, "disable_buyer_local_currency", false)) !== true;
}

export { detectedBuyerCurrency };

// Mime types Rails registers for the `format` query values below (Mime::Type.register in action_dispatch/http/mime_types.rb).
const FORMAT_PARAM_CONTENT_TYPES: Record<string, string> = {
  text: "text/plain",
  txt: "text/plain",
  js: "text/javascript",
  css: "text/css",
  csv: "text/csv",
  xml: "application/xml",
};

// `head :bad_request` / `head :service_unavailable`: no body, typed by the request format without a charset.
function headResponse(status: number, request: MutationInput["request"]): Rendered {
  const format = requestFormat(request);
  // "other" reaches here from an Accept header (not modelled) or a `format` param; only a registered param is typed.
  const param = queryParam(request, "format");
  const contentType =
    format === "json"
      ? "application/json"
      : format === "html"
        ? "text/html"
        : typeof param === "string"
          ? FORMAT_PARAM_CONTENT_TYPES[param]
          : undefined;
  if (contentType === undefined) return handBack("with a request format whose content type is not modelled");
  return { status, body: "", contentType, paramsRead: true };
}

type CartLine = Row;

// Ruby's Integer#/ floors and Integer#% takes the divisor's sign, unlike BigInt.
const floorDiv = (a: bigint, b: bigint): bigint => ((a / b) * b === a || a >= 0n ? a / b : a / b - 1n);
const modulo = (a: bigint, b: bigint): bigint => a - floorDiv(a, b) * b;

// CustomerSurchargeController#calculate_all
export async function calculateAll(input: Pick<MutationInput, "params" | "request">): Promise<ActionResult> {
  try {
    return await calculateAllLines(input);
  } catch (error) {
    if (error instanceof RateUnavailable) return headResponse(503, input.request);
    throw error;
  }
}

async function calculateAllLines({
  params,
  request,
}: Pick<MutationInput, "params" | "request">): Promise<ActionResult> {
  const products = params.products;
  if (blank(products) || (Array.isArray(products) && products.length === 0)) return handBack("without products");
  if (!validProductsParam(products)) return headResponse(400, request);

  // Direct-listed amounts (Payment Element) and page-issued list tokens change the rate and the response.
  if (params.payment_details_source === "payment_element" || !blank(params.payment_element_direct_listed_currency)) {
    return handBack("for a Payment Element request");
  }
  if (!blank(params.payment_method_list_token)) return handBack("with a payment method list token");
  const location: BuyerLocation = {
    postal_code: textParam(params.postal_code, "postal_code"),
    country: textParam(params.country, "country"),
    state: textParam(params.state, "state"),
  };

  const vatId = textParam(params.vat_id, "vat_id");
  const lines: SurchargeLine[] = [];
  const sellerIds = new Set<bigint>();
  const rates = new Map<string, number>();
  let allLinesQuotable = true;
  for (const item of products as CartLine[]) {
    const permalink = item.permalink;
    if (typeof permalink !== "string") return handBack("with a permalink that is not a string");
    const link = await findLinkByPermalink(permalink);
    if (link === null) {
      allLinesQuotable = false;
      continue;
    }
    if (!blank(item.subscription_id)) return handBack("for a subscription renewal line");
    // buyer_currency_charge_details picks the first of preorder, commission, installment, membership.
    const preorder = flagSet(link, "is_in_preorder_state");
    if (!preorder && link.native_type === "commission") return handBack("for a commission line");

    const submittedPrice = submittedPriceCents(item.price);
    const listedCurrency = String(link.price_currency_type ?? "").toLowerCase();
    // The listed rate only prices shipping, but `get_rate` is the call that can fail the whole request (503 in calculateAll).
    if (listedCurrency !== "usd" && !rates.has(listedCurrency)) {
      rates.set(listedCurrency, rubyStringToF(await getRate(String(link.price_currency_type))));
    }

    const shipping = flagSet(link, "is_physical")
      ? await shippingUsdCents(link, location.country ?? null, item.quantity, rates.get(listedCurrency))
      : 0;
    const ip = remoteIp(request);
    const context = { shippingCents: shipping, quantity: item.quantity, vatId };
    const taxResult = await calculateSalesTax(link, submittedPrice, location, ip, context);
    const line: SurchargeLine = { taxResult, shippingUsdCents: shipping };
    if (preorder) {
      // Nothing is charged now: the whole price is the balance due at release.
      line.chargeCanonicalTotalCents = 0;
    } else if (castBoolean(item.pay_in_installments) === true) {
      const installments = await installmentCount(link.id);
      if (installments !== null) {
        // The first installment (plus the whole tip) is what is charged now, taxed on its own.
        const tip = Math.min(Math.max(tipCents(item.tip_cents), 0), Math.max(taxResult.priceCents, 0));
        const baseCents = BigInt(taxResult.priceCents - tip);
        const first = Number(floorDiv(baseCents, installments) + modulo(baseCents, installments));
        const chargeTax = await calculateSalesTax(link, first + tip, location, ip, context);
        line.chargeCanonicalTotalCents = chargeTax.priceCents + Math.max(chargeTax.taxCents, 0) + shipping;
      }
    }
    // A membership without installments charges the same price, taxed and shipped the same way.
    lines.push(line);
    if (link.user_id !== null) sellerIds.add(link.user_id);
  }

  // A cart whose every seller is in the rollout gets an FX quote and a currency menu.
  if (allLinesQuotable && sellerIds.size > 0) {
    let someSellerOut = false;
    for (const sellerId of sellerIds) {
      if (!(await sellerEnabled(sellerId))) {
        someSellerOut = true;
        break;
      }
    }
    if (!someSellerOut) return handBack("for a cart of sellers using buyer-currency charging");
  }

  const detected = detectedBuyerCurrency(remoteIp(request));
  const totals = surchargeTotals(lines);
  return jsonResponse(
    {
      vat_id_valid: totals.vat_id_valid,
      has_vat_id_input: totals.has_vat_id_input,
      shipping_rate_cents: totals.shipping_rate_cents,
      tax_cents: totals.tax_cents,
      tax_included_cents: totals.tax_included_cents,
      subtotal: totals.subtotal,
      charge_canonical_total_cents: allLinesQuotable ? chargeCanonicalTotalCents(lines) : null,
      commission_completion_canonical_total_cents: allLinesQuotable ? 0 : null,
      direct_listed_line_allocations: null,
      direct_listed_amount_token: null,
      direct_listed_amount_token_expires_at: null,
      buyer_currency_quote: null,
      detected_buyer_currency: detected,
      available_buyer_currencies: [{ code: "usd", label: USD_LABEL }],
    },
    200,
    true,
  );
}

// The route is public: Rails' CSRF check (mutation.ts) is the only gate.
registerMutations({
  method: "POST",
  pattern: "/customer_surcharge",
  formats: ["any"],
  run: (input) => calculateAll(input),
});
