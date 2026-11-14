// Ports of GenerateFinancialReportsForPreviousQuarterJob and GenerateFinancialReportsForPreviousMonthJob. Both are
// `return unless Rails.env.production?` and, in production, validate a period and enqueue the report jobs for it; they include
// FinanceReportFailureAlert (and so FinanceReportCompletionTracking), which finance-report-jobs.ts runs. A period Ruby would read as a
// Float is not ported and hands back before the first push.
// Golden: __fixtures__/generate-financial-reports-jobs.golden.json (scripts/golden/generate-financial-reports-jobs.rb).
import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  type FinanceReportDeps,
  type FinanceReportJob,
  financeReportJobWith,
  financeReportRetriesExhaustedWith,
} from "./finance-report-jobs.ts";
import type { JobContext } from "./types.ts";

const FIRST_YEAR = 2014;
const LAST_YEAR = 3200;
// Compliance::Countries::TAXABLE_US_STATE_CODES
const TAXABLE_US_STATE_CODES = [
  "AR", "AZ", "CO", "CT", "DC", "GA", "HI", "IA", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "MI", "MN", "NC", "ND", "NE", "NJ", "NV",
  "NY", "OH", "OK", "PA", "RI", "SD", "TN", "TX", "UT", "VT", "WA", "WI", "WV", "WY",
]; // prettier-ignore
// Compliance::Countries::GBR, AUS, SGP, NOR alpha2 codes
const QUARTERLY_SALES_REPORT_COUNTRIES = ["GB", "AU", "SG", "NO"];
// GenerateSalesReportJob::ALL_SALES
const ALL_SALES = "all_sales";

// `value.in?(min..max)`: an Integer is compared; a Float is a case Node does not run; anything else is never in an Integer range.
function inRange(value: JsonValue | undefined, min: number, max: number): boolean {
  if (value instanceof RubyFloat) throw new HandBackToRuby("a period argument that is a Float");
  return typeof value === "number" && value >= min && value <= max;
}

const isoDate = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// `Date.current.prev_quarter.beginning_of_quarter` as [quarter, year].
function previousQuarter(now: Date): [number, number] {
  const current = Math.floor(now.getUTCMonth() / 3) + 1;
  return current === 1 ? [4, now.getUTCFullYear() - 1] : [current - 1, now.getUTCFullYear()];
}

// `Date.current.prev_month` as [month, year].
function previousMonth(now: Date): [number, number] {
  const month = now.getUTCMonth() + 1;
  return month === 1 ? [12, now.getUTCFullYear() - 1] : [month - 1, now.getUTCFullYear()];
}

const missing = (value: JsonValue | undefined) => value === undefined || value === null;
// `value ||= default`: nil and false are replaced.
const orDefault = (value: JsonValue | undefined, fallback: number): JsonValue => (!value ? fallback : value);

async function validatedPeriod(
  args: JsonValue[],
  deps: FinanceReportDeps,
  defaults: (now: Date) => [number, number],
  first: { name: string; min: number; max: number },
): Promise<[number, number]> {
  let [first_, year] = [args[0], args[1]] as [JsonValue | undefined, JsonValue | undefined];
  if (missing(first_) || missing(year)) {
    const [defaultFirst, defaultYear] = defaults(deps.now());
    first_ = orDefault(first_, defaultFirst);
    year = orDefault(year, defaultYear);
  }
  if (!inRange(first_, first.min, first.max)) throw new Error(`Invalid ${first.name}`);
  if (!inRange(year, FIRST_YEAR, LAST_YEAR)) throw new Error("Invalid year");
  return [first_ as number, year as number];
}

async function quarterlyReports(args: JsonValue[], deps: FinanceReportDeps, context: JobContext): Promise<void> {
  const [quarter, year] = await validatedPeriod(args, deps, previousQuarter, { name: "quarter", min: 1, max: 4 });
  const startMonth = (quarter - 1) * 3 + 1;
  const start = isoDate(year, startMonth, 1);
  const end = isoDate(year, startMonth + 2, lastDayOf(year, startMonth + 2));

  await enqueueWith(context.runtime, "CreateVatReportJob", [quarter, year]);
  for (const country of QUARTERLY_SALES_REPORT_COUNTRIES) {
    await enqueueWith(context.runtime, "GenerateSalesReportJob", [country, start, end, ALL_SALES]);
  }
}

async function monthlyReports(args: JsonValue[], deps: FinanceReportDeps, context: JobContext): Promise<void> {
  const [month, year] = await validatedPeriod(args, deps, previousMonth, { name: "month", min: 1, max: 12 });

  await enqueueWith(context.runtime, "CreateCanadaMonthlySalesReportJob", [month, year]);
  await enqueueWith(context.runtime, "GenerateFeesByCreatorLocationReportJob", [month, year]);
  await enqueueWith(context.runtime, "CreateUsStatesSalesSummaryReportJob", [TAXABLE_US_STATE_CODES, month, year]);
  await enqueueWith(context.runtime, "GenerateCanadaSalesReportJob", [month, year]);
  await enqueueWith(context.runtime, "CreateGlobalSalesTaxSummaryReportJob", [month, year]);
}

export const GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_QUARTER_JOB: FinanceReportJob = {
  name: "GenerateFinancialReportsForPreviousQuarterJob",
  longRunning: false,
  maxArgs: 2,
  defaultAlertArgs: (referenceTime) => previousQuarter(referenceTime),
  production: quarterlyReports,
};
export const GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_MONTH_JOB: FinanceReportJob = {
  name: "GenerateFinancialReportsForPreviousMonthJob",
  longRunning: false,
  maxArgs: 2,
  defaultAlertArgs: (referenceTime) => previousMonth(referenceTime),
  production: monthlyReports,
};

export const generateFinancialReportsForPreviousQuarterJob = financeReportJobWith(
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_QUARTER_JOB,
);
export const generateFinancialReportsForPreviousMonthJob = financeReportJobWith(
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_MONTH_JOB,
);
export const generateFinancialReportsForPreviousQuarterJobRetriesExhausted = financeReportRetriesExhaustedWith(
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_QUARTER_JOB,
);
export const generateFinancialReportsForPreviousMonthJobRetriesExhausted = financeReportRetriesExhaustedWith(
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_MONTH_JOB,
);
