// Replays report-job-arguments.golden.json (scripts/golden/report-job-arguments.rb): the tax and sales report jobs run by the real app
// as Sidekiq jobs. Node raises the ArgumentError Rails raised for a rejected period, subdivision or sales type, and hands every run that
// passes the checks back to Rails before any statement. Arguments Ruby reads as a Float, and country codes Node does not look up, hand back.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RubyFloat, parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import {
  COUNTRY_CODES,
  US_SUBDIVISION_CODES,
  createCanadaMonthlySalesReportJob,
  createCanadaMonthlySalesReportJobRetriesExhausted,
  createIndiaSalesReportJobRetriesExhausted,
  createVatReportJobRetriesExhausted,
  generateCanadaSalesReportJobRetriesExhausted,
  generateFeesByCreatorLocationReportJobRetriesExhausted,
  generateSalesReportJobRetriesExhausted,
  createGlobalSalesTaxSummaryReportJob,
  createGlobalSalesTaxSummaryReportJobRetriesExhausted,
  createIndiaSalesReportJobWith,
  createUsStateMonthlySalesReportsJob,
  createUsStatesSalesSummaryReportJob,
  createUsStatesSalesSummaryReportJobRetriesExhausted,
  createVatReportJob,
  generateCanadaSalesReportJob,
  generateFeesByCreatorLocationReportJob,
  generateSalesReportJob,
} from "./report-job-arguments.ts";

const url = new URL("./__fixtures__/report-job-arguments.golden.json", import.meta.url);
const golden = loadGolden(url);
const raw = parseRubyJson(readFileSync(url, "utf8")) as unknown as {
  subdivision_codes: string[];
  country_codes: string[];
};
const casesOf = (job: string) => ({
  now: golden.now,
  cases: golden.cases.filter((c) => (c as JobCase & { job: string }).job === job),
});
const isRejected = (c: JobCase) => /^(Invalid |wrong number)/u.test(c.error?.message ?? "");
const isFloat = (value: JsonValue | undefined) => value instanceof RubyFloat;
const inRange = (value: JsonValue | undefined, min: number, max: number) =>
  typeof value === "number" && value >= min && value <= max;

// Node hands back the first Float it reaches in the period checks, which Ruby reads as a number.
const periodHandsBack = (min: number, max: number, at: number) => (c: JobCase) => {
  if (c.hands_back) return true;
  if (c.error?.message.startsWith("wrong number")) return false;
  const first = c.args[at];
  if (isFloat(first)) return true;
  return inRange(first, min, max) && isFloat(c.args[at + 1]);
};

describe("report job tables", () => {
  it("lists the subdivisions and countries Rails accepts", () => {
    expect(US_SUBDIVISION_CODES).toEqual(raw.subdivision_codes);
    expect(COUNTRY_CODES).toEqual(raw.country_codes);
  });

  it("records no statement before a hand-back", () => {
    for (const c of golden.cases)
      if (c.hands_back) expect(c.statements.every((s) => /^\s*(select|set|show)\b/iu.test(s.sql))).toBe(true);
  });
});

for (const [name, handler] of [
  ["CreateCanadaMonthlySalesReportJob", createCanadaMonthlySalesReportJob],
  ["CreateGlobalSalesTaxSummaryReportJob", createGlobalSalesTaxSummaryReportJob],
  ["GenerateCanadaSalesReportJob", generateCanadaSalesReportJob],
  ["GenerateFeesByCreatorLocationReportJob", generateFeesByCreatorLocationReportJob],
] as const) {
  replayJobGolden(name, casesOf(name), handler, periodHandsBack(1, 12, 0));
}
replayJobGolden("CreateVatReportJob", casesOf("CreateVatReportJob"), createVatReportJob, periodHandsBack(1, 4, 0));
replayJobGolden(
  "CreateUsStatesSalesSummaryReportJob",
  casesOf("CreateUsStatesSalesSummaryReportJob"),
  createUsStatesSalesSummaryReportJob,
  // A subdivision list that is not an Array raises in Ruby after the checks: Node hands it back.
  (c) => periodHandsBack(1, 12, 1)(c) || (c.error === null ? false : !Array.isArray(c.args[0]) && !isRejected(c)),
);
replayJobGolden(
  "CreateUsStateMonthlySalesReportsJob",
  casesOf("CreateUsStateMonthlySalesReportsJob"),
  createUsStateMonthlySalesReportsJob,
  (c) => {
    const valid = typeof c.args[0] === "string" && US_SUBDIVISION_CODES.includes(c.args[0]);
    return c.hands_back || (valid && periodHandsBack(1, 12, 1)(c));
  },
);
const caseNowOf = (c: JobCase) => {
  const value = (c as JobCase & { case_now: unknown }).case_now;
  return value instanceof RubyFloat ? value.value : Number(value);
};
for (const now of new Set(casesOf("CreateIndiaSalesReportJob").cases.map(caseNowOf))) {
  const india = casesOf("CreateIndiaSalesReportJob");
  replayJobGolden(
    `CreateIndiaSalesReportJob at ${now}`,
    { now, cases: india.cases.filter((c) => caseNowOf(c) === now) },
    createIndiaSalesReportJobWith({ now: () => new Date(Math.round(now * 1000)) }),
    (c) => c.hands_back || (!c.error?.message.startsWith("wrong number") && (isFloat(c.args[0]) || isFloat(c.args[1]))),
  );
}
replayJobGolden("GenerateSalesReportJob", casesOf("GenerateSalesReportJob"), generateSalesReportJob, (c) => {
  if (c.hands_back) return true;
  // Past the country and sales type, Ruby parses the dates (Date::Error): Node hands that back.
  const listed = typeof c.args[0] === "string" && COUNTRY_CODES.includes(c.args[0]);
  if (c.error?.message.startsWith("wrong number")) return false;
  return !listed || (c.error !== null && c.error.message !== "Invalid sales type");
});

describe("retries-exhausted hooks", () => {
  for (const [name, hook] of [
    ["CreateGlobalSalesTaxSummaryReportJob", createGlobalSalesTaxSummaryReportJobRetriesExhausted],
    ["CreateCanadaMonthlySalesReportJob", createCanadaMonthlySalesReportJobRetriesExhausted],
    ["CreateIndiaSalesReportJob", createIndiaSalesReportJobRetriesExhausted],
    ["CreateVatReportJob", createVatReportJobRetriesExhausted],
    ["GenerateCanadaSalesReportJob", generateCanadaSalesReportJobRetriesExhausted],
    ["GenerateFeesByCreatorLocationReportJob", generateFeesByCreatorLocationReportJobRetriesExhausted],
    ["GenerateSalesReportJob", generateSalesReportJobRetriesExhausted],
    ["CreateUsStatesSalesSummaryReportJob", createUsStatesSalesSummaryReportJobRetriesExhausted],
  ] as const) {
    it(`${name} hands the failure mail back to Rails`, () => {
      expect(() => hook()).toThrowError(/Handed back to Rails/u);
    });
  }
});
