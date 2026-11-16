// Replays __fixtures__/money-format.golden.json (scripts/golden/money-format.rb): the real MoneyFormatter
// over the money gem, for every currency it knows and a grid of amounts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import DATA from "../money-currencies.generated.json" with { type: "json" };
import { formatChargePresentmentAmount, formattedAmountInCurrency, moneyFormatterFormat, symbolFor, UnknownCurrency } from "./money-formatter.ts";

type Result = string | { error: { class: string; message: string } };
type Amount = number | null | { $float: string };
const golden = JSON.parse(readFileSync(new URL("../__fixtures__/money-format.golden.json", import.meta.url), "utf8")) as {
  money_version: string;
  vectors: [string, string, Amount, Result][];
  symbols: Record<string, string>;
};

const amountOf = (amount: Amount) => (amount !== null && typeof amount === "object" ? Number(amount.$float) : amount);

function run(mode: string, code: string, amount: Amount): Result {
  const value = amountOf(amount);
  try {
    switch (mode) {
      case "format":
        return moneyFormatterFormat(value, code, { noCentsIfWhole: true });
      case "format_no_symbol":
        return moneyFormatterFormat(value, code, { noCentsIfWhole: false, symbol: false });
      case "in_currency":
        return formattedAmountInCurrency(value, code);
      case "charge_presentment":
        return formatChargePresentmentAmount(value as number | null, code);
      default:
        throw new Error(`unknown mode ${mode}`);
    }
  } catch (error) {
    if (error instanceof UnknownCurrency) return { error: { class: error.rubyClass, message: error.message } };
    throw error;
  }
}

describe("MoneyFormatter", () => {
  it("was recorded against the money gem version the table was read from", () => {
    expect(golden.money_version).toBe(DATA.money_version);
  });

  for (const mode of ["format", "format_no_symbol", "in_currency", "charge_presentment"]) {
    it(`matches Ruby for ${mode} across every currency and amount`, () => {
      const vectors = golden.vectors.filter(([m]) => m === mode);
      expect(vectors.length).toBeGreaterThan(0);
      const mismatches = vectors.flatMap(([, code, amount, expected]) => {
        const actual = run(mode, code, amount);
        return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ code, amount, expected, actual }];
      });
      expect(mismatches.slice(0, 5)).toEqual([]);
    });
  }

  it("matches Ruby's symbol for every currency", () => {
    expect(Object.fromEntries(Object.keys(golden.symbols).map((code) => [code, symbolFor(code)]))).toEqual(golden.symbols);
  });
});
