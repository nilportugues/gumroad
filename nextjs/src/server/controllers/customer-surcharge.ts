// Port of app/controllers/customer_surcharge_controller.rb#calculate_all (POST /customer_surcharge) for the carts whose
// answer needs no vendor: one-time, non-physical lines with no VAT id, no TaxJar buyer (US taxable state, Canada with a
// province) and no seller in the buyer-currency rollout, so the response carries no FX quote and no direct-listed token.
//
// Everything else hands back to Rails before anything is written (nothing here writes): a physical, preorder, commission,
// membership or installment line, a subscription renewal, a VAT id, a Payment Element or list-token request, a seller with
// `buyer_currency_charging` on, Singapore (`applicable_years`), a Spanish rate (the GeoIP subdivision names), a bundle bound
// for an EU-27 rate, a missing `products` (ParameterMissing is rendered by the exceptions app) and a request whose format
// is neither html nor json (the content type of `head`). The 400 (malformed `products`) and 503 (RateUnavailable) answers
// are served: an empty body typed by the request format.
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";

import { BUYER_CURRENCY_BY_COUNTRY } from "../infra/buyer-currency-countries.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { geoIpLookup, type GeoIpResult } from "../infra/geo-ip.ts";
import { getRate, RateUnavailable } from "../models/concerns/currency-helper.ts";
import { LinkFlags } from "../models/link.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { jsonDataForAttr, Users } from "../models/user.ts";
import { hasBrazilianStripeConnectAccount } from "../page-props/dashboard/payout-info.ts";
import { findUserById, type LinkRow } from "../presenters/product-reads.ts";
import { castBoolean } from "../search/ruby-params.ts";
import {
  calculateWithLookup,
  oneTimeChargeTotalCents,
  surchargeTotals,
  validProductsParam,
  type SurchargeLine,
} from "../tax/customer-surcharge.ts";
import {
  buyerTaxRegion,
  esVatExemptWithoutGeoIp,
  taxEligible,
  type BuyerLocation,
  zeroTax,
  type SalesTaxCalculation,
} from "../tax/sales-tax-calculation.ts";
import {
  COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
  COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS,
  EU_VAT_APPLICABLE_COUNTRY_CODES,
} from "../tax/sales-tax-countries.ts";

import { HandBackToRails, type ActionResult, type Rendered } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, remoteIp, type MutationInput } from "./mutation.ts";
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

// `ActiveModel::Type::Boolean.new.cast(item[:pay_in_installments])` is false for these; any other value may choose an installment plan.
const NOT_INSTALLMENTS = new Set<unknown>([undefined, null, false, "", 0, "0", "false"]);

// Link.find_by_unique_permalink
async function findLinkByPermalink(permalink: string): Promise<LinkRow | null> {
  const [row] = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
  );
  return row ?? null;
}

const flagSet = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]): boolean =>
  LinkFlags.isSet(row.flags as bigint | number, name);

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

// SalesTaxCalculator#calculate_with_lookup_table for a buyer who is neither a US taxable state nor a Canadian province.
async function lookupRate(link: LinkRow, location: BuyerLocation, state: string | null): Promise<Row | null> {
  const country = location.country;
  if (blank(country)) return null;
  const code = country!;
  const epublication = flagSet(link, "is_epublication");

  if (EU_VAT_APPLICABLE_COUNTRY_CODES.includes(code) || code === "NO") return firstZipTaxRate(code, { epublication });
  if (code === "AU") return firstZipTaxRate(code, { epublication: false });
  if (code === "SG") return handBack("for Singapore, whose rate year comes from json_data");
  if (code === "CA") return firstZipTaxRate(code, { state, epublication: false });

  const collects =
    COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS.includes(code) ||
    COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS.includes(code);
  if (!(await isFeatureEnabled(`collect_tax_${code.toLowerCase()}`)) || !collects) return null;
  return firstZipTaxRate(code, SPECIAL_EPUBLICATION_COUNTRIES.includes(code) ? { epublication } : {});
}

// SalesTaxCalculator#calculate for a buyer with no VAT id. A TaxJar buyer (US taxable state, Canadian province) hands back.
export async function calculateSalesTax(
  link: LinkRow,
  priceCents: number,
  location: BuyerLocation,
): Promise<SalesTaxCalculation> {
  const region = buyerTaxRegion(location);
  const sellerId = link.user_id;
  if (priceCents === 0) return zeroTax(priceCents);
  if (sellerId !== null && (await hasBrazilianStripeConnectAccount(sellerId))) return zeroTax(priceCents);
  if (region.isUsTaxableState || region.isCaTaxable) return handBack("for a buyer taxed through TaxJar");

  const row = await lookupRate(link, location, region.state);
  let rate: { country: string; combinedRate: string } | null = null;
  let eligible = false;
  if (row !== null) {
    const country = String(row.country);
    // is_vat_exempt?: only Spain's rows can be exempt.
    const exempt = esVatExemptWithoutGeoIp(country, location);
    if (exempt === undefined) return handBack("for a Spanish rate, which reads the GeoIP subdivision names");
    if (!exempt) {
      rate = { country, combinedRate: new Prisma.Decimal(row.combined_rate as never).toFixed(7) };
      const flag = `collect_tax_${country.toLowerCase()}`;
      const flagActive = await isFeatureEnabled(flag);
      eligible = taxEligible({
        rateCountry: country,
        rateIsSellerOwn: row.user_id !== null && row.user_id !== undefined,
        isPhysical: false,
        region,
        featureActive: (name) => name === flag && flagActive,
        entirelyPhysicalShipment: () =>
          flagSet(link, "is_bundle") ? handBack("for a bundle bound for an EU rate") : false,
      });
    }
  }
  return calculateWithLookup({
    priceCents,
    buyerVatIdPresent: false,
    vatIdValid: false,
    sellerHasBrazilianConnectAccount: false,
    rate,
    taxEligible: eligible,
    isQuebec: false,
  });
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

// CurrencyHelper#buyer_currency_for_ip: the GeoIP country's currency when config/currencies.json supports it.
export function detectedBuyerCurrency(
  ip: string | null,
  lookup: (ip: string | null) => Pick<GeoIpResult, "countryCode"> | null = geoIpLookup,
): string | null {
  const countryCode = lookup(ip)?.countryCode;
  if (countryCode === undefined || countryCode === null || blank(countryCode)) return null;
  return BUYER_CURRENCY_BY_COUNTRY[countryCode.toUpperCase()] ?? null;
}

// `head :bad_request` / `head :service_unavailable`: no body, typed by the request format without a charset.
function headResponse(status: number, request: MutationInput["request"]): Rendered {
  const format = requestFormat(request);
  if (format === "other") return handBack("with a request format whose content type is not modelled");
  return { status, body: "", contentType: format === "json" ? "application/json" : "text/html", paramsRead: true };
}

type CartLine = Row;

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
  if (!blank(params.vat_id)) return handBack("with a VAT id");

  const location: BuyerLocation = {
    postal_code: textParam(params.postal_code, "postal_code"),
    country: textParam(params.country, "country"),
    state: textParam(params.state, "state"),
  };

  const lines: SurchargeLine[] = [];
  const sellerIds = new Set<bigint>();
  const rates = new Set<string>();
  let allLinesQuotable = true;
  for (const item of products as CartLine[]) {
    const permalink = item.permalink;
    if (typeof permalink !== "string") return handBack("with a permalink that is not a string");
    const link = await findLinkByPermalink(permalink);
    if (link === null) {
      allLinesQuotable = false;
      continue;
    }
    if (
      flagSet(link, "is_physical") ||
      flagSet(link, "is_in_preorder_state") ||
      flagSet(link, "is_recurring_billing") ||
      link.native_type === "commission" ||
      !NOT_INSTALLMENTS.has(item.pay_in_installments) ||
      !blank(item.subscription_id)
    ) {
      return handBack("for a physical, preorder, commission, membership, installment or renewal line");
    }

    const submittedPrice = submittedPriceCents(item.price);
    const listedCurrency = String(link.price_currency_type ?? "").toLowerCase();
    // The listed rate only prices shipping, but `get_rate` is the call that can fail the whole request (503 in calculateAll).
    if (listedCurrency !== "usd" && !rates.has(listedCurrency)) {
      await getRate(String(link.price_currency_type));
      rates.add(listedCurrency);
    }

    lines.push({ taxResult: await calculateSalesTax(link, submittedPrice, location), shippingUsdCents: 0 });
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
      charge_canonical_total_cents: allLinesQuotable ? oneTimeChargeTotalCents(totals) : null,
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
