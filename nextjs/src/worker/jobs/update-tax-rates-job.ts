// Port of app/sidekiq/update_tax_rates_job.rb: pulls TaxJar's summary rates and brings the `zip_tax_rates` rows for the VAT countries,
// the taxable US states and the Canadian provinces in line, telling #payments about every change. Three passes over the same answer,
// as in Ruby, so an entry that repeats is seen again by the later pass. Golden: __fixtures__/update-tax-rates-job.golden.json
// (scripts/golden/update-tax-rates-job.rb), TaxJar's answer standing in through WebMock.
//
// Ruby reads an entry's `average_rate.rate` only once its country, state or province qualifies, and fails with a NoMethodError or an
// ArgumentError in the middle of the writes when it is missing or not a number. Node reads every qualifying entry first and hands the
// job back before the first write, so nothing is half done.
import { Prisma, type ZipTaxRate } from "@prisma/client";

import { rubyFloatToS } from "../../lib/ruby-to-s.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { rubyFloatRoundDigits } from "../../server/models/concerns/ruby-numeric.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { ZipTaxRateFlags, ZipTaxRateDeletable, ZipTaxRates } from "../../server/models/zip-tax-rate.ts";
import {
  CANADA_SUBDIVISION_CODES,
  EU_VAT_APPLICABLE_COUNTRY_CODES,
  isTaxableState,
} from "../../server/tax/sales-tax-countries.ts";
import { fetchSummaryRates, type SummaryRatesDeps } from "../../server/tax/taxjar-summary-rates.ts";

import { bigDecimalToS } from "./scheduled-check-jobs.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

const ZIP_TAX_RATES = "zip_tax_rates";
const UPDATER = "VAT Rate Updater";
const USA = "US";
const CANADA = "CA";
// ZipTaxRate#combined_rate is decimal(8, 7)
const RATE_SCALE = 7;
const MAX_RATE = 10;
// A Float with more significant digits than this compares to a BigDecimal through a rounding Node does not reproduce.
const SAFE_SIGNIFICANT_DIGITS = 15;
// TaxJar uses different county codes instead of sticking to ISO-3166-1
const TAX_JAR_COUNTRY_CODES: Readonly<Record<string, string>> = { EL: "GR", UK: "GB" };

type SummaryRate = { countryCode: string | null; regionCode: string | null; averageRate: unknown };
type Rate = SummaryRate & { rate: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mappedCountry = (code: string | null): string | null =>
  code !== null && Object.hasOwn(TAX_JAR_COUNTRY_CODES, code) ? TAX_JAR_COUNTRY_CODES[code]! : null;

const isVatCountry = (rate: SummaryRate) =>
  rate.countryCode !== null &&
  (EU_VAT_APPLICABLE_COUNTRY_CODES.includes(rate.countryCode) || mappedCountry(rate.countryCode) !== null);
const isTaxableUsState = (rate: SummaryRate) => rate.countryCode === USA && isTaxableState(rate.regionCode);
const isCanadianProvince = (rate: SummaryRate) =>
  rate.countryCode === CANADA && rate.regionCode !== null && CANADA_SUBDIVISION_CODES.includes(rate.regionCode);

// A string or nil attribute as Taxjar::SummaryRate coerces it; anything else it would stringify.
function textOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new HandBackToRuby("a TaxJar summary rate whose code is not a string");
}

function parseSummaryRates(payload: unknown): SummaryRate[] {
  if (!Array.isArray(payload)) throw new HandBackToRuby("a TaxJar answer whose summary_rates is not an array");
  return payload.map((entry) => {
    if (!isRecord(entry)) throw new HandBackToRuby("a TaxJar summary rate that is not an object");
    return {
      countryCode: textOrNull(entry.country_code),
      regionCode: textOrNull(entry.region_code),
      averageRate: entry.average_rate,
    };
  });
}

// `summary_rate.average_rate.rate`, a Float: an Integer is converted, a missing or non-numeric one fails in Ruby.
function rateOf(summaryRate: SummaryRate): Rate {
  const average = summaryRate.averageRate;
  const rate = isRecord(average) ? average.rate : undefined;
  if (typeof rate !== "number" || !Number.isFinite(rate) || Math.abs(rate) >= MAX_RATE)
    throw new HandBackToRuby("a TaxJar average rate that is missing or not a plain number");
  if (Number(rate.toPrecision(SAFE_SIGNIFICANT_DIGITS)) !== rate)
    throw new HandBackToRuby("a TaxJar rate with more than 15 digits");
  return { ...summaryRate, rate };
}

// What each pass will read, keyed by the entries it reaches (the pass-1 and pass-2 conditions come before the rate is read).
function ratesToRead(summaryRates: SummaryRate[]): Map<SummaryRate, Rate> {
  const rates = new Map<SummaryRate, Rate>();
  for (const summaryRate of summaryRates) {
    if (isVatCountry(summaryRate) || isTaxableUsState(summaryRate) || isCanadianProvince(summaryRate))
      rates.set(summaryRate, rateOf(summaryRate));
  }
  return rates;
}

// Assigning a Float to the decimal(8, 7) column rounds it to the scale first.
const castRate = (rate: number) => new Prisma.Decimal(String(rubyFloatRoundDigits(rate, RATE_SCALE)));
// `BigDecimal != Float`
const sameRate = (stored: Prisma.Decimal | null, rate: number) =>
  stored?.equals(new Prisma.Decimal(String(rate))) ?? false;
const describeRate = (stored: Prisma.Decimal | null) => (stored === null ? "" : bigDecimalToS(stored));

const notEpublication = () => Prisma.sql`(${ZipTaxRateFlags.condition("is_epublication_rate", false)})`;
const star = Prisma.raw("`zip_tax_rates`.*");

async function firstRow(sql: Prisma.Sql) {
  const [row] = await selectRows(sql);
  return row ? ZipTaxRates.load(castRow<ZipTaxRate>("ZipTaxRate", row)) : null;
}

export type UpdateTaxRatesDeps = JobDeps & SummaryRatesDeps;

export const updateTaxRatesJobWith = (overrides: Partial<UpdateTaxRatesDeps> = {}) =>
  modelJob({ min: 0 }, async (_args, deps) => {
    const notify = (message: string) =>
      performAsync("InternalNotificationWorker", ["payments", UPDATER, message, "green"]);
    const save = { now: deps.now };

    const summaryRates = parseSummaryRates(await fetchSummaryRates({ fetch: overrides.fetch }));
    const rates = ratesToRead(summaryRates);

    // EU and other VAT countries: ZipTaxRate.not_is_epublication_rate.alive.where(country:).first
    for (const summaryRate of summaryRates.filter(isVatCountry)) {
      const { rate } = rates.get(summaryRate)!;
      if (!(rate > 0)) continue;

      const countryCode = mappedCountry(summaryRate.countryCode) ?? summaryRate.countryCode!;
      const zipTaxRate = await firstRow(
        Prisma.sql`SELECT ${star} FROM ${table(ZIP_TAX_RATES)} WHERE ${notEpublication()} AND ${column(ZIP_TAX_RATES, "deleted_at")} IS NULL AND ${column(ZIP_TAX_RATES, "country")} = ${countryCode} ORDER BY ${column(ZIP_TAX_RATES, "id")} ASC LIMIT 1`,
      );
      if (zipTaxRate) {
        const stored = zipTaxRate.get("combined_rate");
        if (!sameRate(stored, rate)) {
          await notify(`VAT rate has changed for ${countryCode} from ${describeRate(stored)} to ${rubyFloatToS(rate)}`);
          zipTaxRate.set("combined_rate", castRate(rate));
          await ZipTaxRates.saveBang(zipTaxRate, save);
        }
      } else {
        await notify(`Creating missing tax rate for ${countryCode} with rate of ${rubyFloatToS(rate)}`);
        // find_or_create_by(country:): the finder ignores `alive`, and the create fails validation without combined_rate, so
        // the row is written by the update.
        const existing = await firstRow(
          Prisma.sql`SELECT ${star} FROM ${table(ZIP_TAX_RATES)} WHERE ${notEpublication()} AND ${column(ZIP_TAX_RATES, "country")} = ${countryCode} LIMIT 1`,
        );
        const record = existing ?? (await ZipTaxRates.create({ country: countryCode } as Partial<ZipTaxRate>, save));
        await ZipTaxRates.update(record, { combined_rate: castRate(rate) }, save);
        // Make sure the tax rate was not in deleted state instead
        await ZipTaxRateDeletable.markUndeletedBang(record, save);
      }
    }

    // Taxable US states: ZipTaxRate.alive.where(country: "US", state:, zip_code: nil).not_is_epublication_rate.first
    for (const summaryRate of summaryRates.filter(isTaxableUsState)) {
      const { rate, regionCode: state } = rates.get(summaryRate)!;
      if (!(rate > 0)) continue;

      // A taxable state is never the seller's to collect.
      const isSellerResponsible = false;
      const zipTaxRate = await firstRow(
        Prisma.sql`SELECT ${star} FROM ${table(ZIP_TAX_RATES)} WHERE ${column(ZIP_TAX_RATES, "deleted_at")} IS NULL AND ${column(ZIP_TAX_RATES, "country")} = ${USA} AND ${column(ZIP_TAX_RATES, "state")} = ${state} AND ${column(ZIP_TAX_RATES, "zip_code")} IS NULL AND ${notEpublication()} ORDER BY ${column(ZIP_TAX_RATES, "id")} ASC LIMIT 1`,
      );
      if (zipTaxRate) {
        const stored = zipTaxRate.get("combined_rate");
        const wasSellerResponsible = ZipTaxRateFlags.isSet(zipTaxRate.get("flags"), "is_seller_responsible");
        if (!sameRate(stored, rate) || isSellerResponsible !== wasSellerResponsible) {
          await notify(
            `US Sales Tax rate for state ${state} has changed. Rate was ${describeRate(stored)}, now it's ${rubyFloatToS(rate)}. is_seller_responsible was ${wasSellerResponsible}, now it's ${isSellerResponsible}`,
          );
          zipTaxRate.set("combined_rate", castRate(rate));
          zipTaxRate.set(
            "flags",
            Number(ZipTaxRateFlags.set(zipTaxRate.get("flags"), "is_seller_responsible", isSellerResponsible)),
          );
          await ZipTaxRates.saveBang(zipTaxRate, save);
        }
      } else {
        await notify(
          `Creating US Sales Tax rate for state ${state} with rate of ${rubyFloatToS(rate)} and is_seller_responsible ${isSellerResponsible}`,
        );
        await ZipTaxRates.createBang(
          { country: USA, state, zip_code: null, combined_rate: castRate(rate) } as Partial<ZipTaxRate>,
          save,
        );
      }
    }

    // Canadian provinces: ZipTaxRate.alive.where(country: "CA", state: province).not_is_epublication_rate.first
    for (const summaryRate of summaryRates.filter(isCanadianProvince)) {
      const { rate, regionCode: province } = rates.get(summaryRate)!;

      const zipTaxRate = await firstRow(
        Prisma.sql`SELECT ${star} FROM ${table(ZIP_TAX_RATES)} WHERE ${column(ZIP_TAX_RATES, "deleted_at")} IS NULL AND ${column(ZIP_TAX_RATES, "country")} = ${CANADA} AND ${column(ZIP_TAX_RATES, "state")} = ${province} AND ${notEpublication()} ORDER BY ${column(ZIP_TAX_RATES, "id")} ASC LIMIT 1`,
      );
      if (zipTaxRate) {
        const stored = zipTaxRate.get("combined_rate");
        if (!sameRate(stored, rate)) {
          await notify(
            `Canada Sales Tax rate for province ${province} has changed. Rate was ${describeRate(stored)}, now it's ${rubyFloatToS(rate)}.`,
          );
          zipTaxRate.set("combined_rate", castRate(rate));
          await ZipTaxRates.saveBang(zipTaxRate, save);
        }
      } else {
        await notify(`Creating Canada Sales Tax rate for province ${province} with rate of ${rubyFloatToS(rate)}`);
        await ZipTaxRates.createBang(
          { country: CANADA, state: province, zip_code: null, combined_rate: castRate(rate) } as Partial<ZipTaxRate>,
          save,
        );
      }
    }
  })(overrides);

export const updateTaxRatesJob = updateTaxRatesJobWith();
