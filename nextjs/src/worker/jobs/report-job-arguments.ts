// Ports of the tax and sales report jobs up to the statement that follows their argument checks: CreateCanadaMonthlySalesReportJob,
// CreateGlobalSalesTaxSummaryReportJob, CreateIndiaSalesReportJob, CreateUsStateMonthlySalesReportsJob,
// CreateUsStatesSalesSummaryReportJob, CreateVatReportJob, GenerateCanadaSalesReportJob, GenerateFeesByCreatorLocationReportJob and
// GenerateSalesReportJob. Each raises ArgumentError for a period, subdivision or sales type it rejects. A run that passes the checks
// builds a CSV from queries under a session statement cap and uploads it to S3, so it goes back to Rails whole before any statement; so
// does a Float argument, which Ruby reads as a number. The retries-exhausted hooks (AccountingMailer, FinanceReportFailureAlert) mail the failure through AccountingMailer and
// hand back whole.
// Golden: __fixtures__/report-job-arguments.golden.json (scripts/golden/report-job-arguments.rb).
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const FIRST_YEAR = 2014;
const LAST_YEAR = 3200;
// Compliance::Countries::USA.subdivisions.keys
export const US_SUBDIVISION_CODES = [
  "AK", "AL", "AR", "AS", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "GU", "HI", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MP", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "PR", "RI", "SC", "SD", "TN", "TX", "UM", "UT", "VA", "VI", "VT", "WA", "WI", "WV", "WY",
]; // prettier-ignore
// ISO3166::Country.all alpha2 codes
export const COUNTRY_CODES: string[] = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "XK", "YE", "YT", "ZA", "ZM", "ZW",
]; // prettier-ignore
// GenerateSalesReportJob::SALES_TYPES
const SALES_TYPES = ["all_sales", "discover_sales"];

type ReportDeps = { now: () => Date };
const defaultDeps: ReportDeps = { now: () => new Date() };

// `value.in?(min..max)`: an Integer is compared; a Float is a case Node does not run; anything else is never in an Integer range.
function inRange(value: JsonValue | undefined, min: number, max: number): boolean {
  if (value instanceof RubyFloat) throw new HandBackToRuby("a period argument that is a Float");
  return typeof value === "number" && value >= min && value <= max;
}

// `value ||= default`: nil and false are replaced.
const orDefault = (value: JsonValue | undefined, fallback: number): JsonValue => (!value ? fallback : value);

function checkPeriod(
  first: JsonValue | undefined,
  name: string,
  min: number,
  max: number,
  year: JsonValue | undefined,
): void {
  if (!inRange(first, min, max)) throw new Error(`Invalid ${name}`);
  if (!inRange(year, FIRST_YEAR, LAST_YEAR)) throw new Error("Invalid year");
}

const handBack = (reason: string): never => {
  throw new HandBackToRuby(reason);
};

const monthYearJob =
  (reason: string): JobHandler =>
  (args) => {
    checkArity(args, 2);
    checkPeriod(args[0], "month", 1, 12, args[1]);
    return Promise.resolve(handBack(reason));
  };

export const createCanadaMonthlySalesReportJob = monthYearJob(
  "the Canada monthly sales report is queried under the statement cap and uploaded to S3",
);
export const createGlobalSalesTaxSummaryReportJob = monthYearJob(
  "the global sales tax summary is aggregated from purchases and mailed",
);
export const generateCanadaSalesReportJob = monthYearJob(
  "the Canada sales report is queried under the statement cap and uploaded to S3",
);
export const generateFeesByCreatorLocationReportJob = monthYearJob(
  "the fees by creator location report is queried under the statement cap",
);

export const createVatReportJob: JobHandler = (args) => {
  checkArity(args, 2);
  checkPeriod(args[0], "quarter", 1, 4, args[1]);
  return Promise.resolve(handBack("the VAT report is built from purchases and uploaded to S3"));
};

// `1.month.ago` as [month, year]: the day does not matter, only the month it lands in.
function previousMonth(now: Date): [number, number] {
  const month = now.getUTCMonth() + 1;
  return month === 1 ? [12, now.getUTCFullYear() - 1] : [month - 1, now.getUTCFullYear()];
}

export function createIndiaSalesReportJobWith(overrides: Partial<ReportDeps> = {}): JobHandler {
  const deps = { ...defaultDeps, ...overrides };
  return (args) => {
    checkArity(args, 0, 2);
    let [month, year] = [args[0], args[1]] as [JsonValue | undefined, JsonValue | undefined];
    if (month === undefined || month === null || year === undefined || year === null) {
      const [previousMonthNumber, previousYear] = previousMonth(deps.now());
      month = orDefault(month, previousMonthNumber);
      year = orDefault(year, previousYear);
    }
    checkPeriod(month, "month", 1, 12, year);
    return Promise.resolve(handBack("the India sales report is queried under the statement cap and uploaded to S3"));
  };
}
export const createIndiaSalesReportJob = createIndiaSalesReportJobWith();

export const createUsStateMonthlySalesReportsJob: JobHandler = (args) => {
  checkArity(args, 3);
  // A hash lookup: only a String key can match, and a code that is not one of the subdivisions is nil.
  if (typeof args[0] !== "string" || !US_SUBDIVISION_CODES.includes(args[0]))
    throw new Error("Invalid subdivision code");
  checkPeriod(args[1], "month", 1, 12, args[2]);
  return Promise.resolve(handBack("the state report is queried from purchases, TaxJar and uploaded to S3"));
};

export const createUsStatesSalesSummaryReportJob: JobHandler = (args) => {
  checkArity(args, 3, 4);
  checkPeriod(args[1], "month", 1, 12, args[2]);
  return Promise.resolve(handBack("the state sales summary is aggregated from purchases and may push to TaxJar"));
};

export const generateSalesReportJob: JobHandler = (args) => {
  checkArity(args, 4, 6);
  // ISO3166::Country[] also reads other spellings of a code, which Node does not reproduce: those go back to Rails.
  if (typeof args[0] !== "string" || !COUNTRY_CODES.includes(args[0]))
    throw new HandBackToRuby("a country code Node does not look up");
  if (typeof args[3] !== "string" || !SALES_TYPES.includes(args[3])) throw new Error("Invalid sales type");
  return Promise.resolve(handBack("the sales report is queried under the statement cap and uploaded to S3"));
};

const exhaustedHandBack = (reason: string) => () => {
  throw new HandBackToRuby(reason);
};

export const createCanadaMonthlySalesReportJobRetriesExhausted = exhaustedHandBack(
  "the failure is mailed through AccountingMailer",
);
export const createGlobalSalesTaxSummaryReportJobRetriesExhausted = exhaustedHandBack(
  "the failure is mailed through AccountingMailer",
);
export const createIndiaSalesReportJobRetriesExhausted = exhaustedHandBack(
  "the failure is mailed through AccountingMailer",
);
export const createUsStatesSalesSummaryReportJobRetriesExhausted = exhaustedHandBack(
  "the failure is mailed through AccountingMailer",
);
export const createVatReportJobRetriesExhausted = exhaustedHandBack("the failure is mailed through AccountingMailer");
export const generateCanadaSalesReportJobRetriesExhausted = exhaustedHandBack(
  "the failure is mailed through AccountingMailer",
);
export const generateFeesByCreatorLocationReportJobRetriesExhausted = exhaustedHandBack(
  "the failure is mailed through AccountingMailer",
);
export const generateSalesReportJobRetriesExhausted = exhaustedHandBack(
  "the failure is mailed through AccountingMailer",
);
