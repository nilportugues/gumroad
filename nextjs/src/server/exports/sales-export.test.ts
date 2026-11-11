import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { yamlColumn } from "../models/concerns/serialized-columns.ts";

import { salesExportQuery, type SalesExportFilters } from "./sales-export.ts";

// The `query` column Rails wrote for each recorded request (spec/requests/api/v2/sales_exports_parity_spec.rb), byte for byte.
const FIXTURES = path.join(__dirname, "../../../parity/fixtures/requests/api/v2/sales_exports_parity_spec");
const recordedQuery = (name: string): string => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, `api-v2-sales-export-${name}.json`), "utf8")) as {
    exchanges: { db: { sales_exports: { inserted: { query: string }[] } } }[];
  };
  return fixture.exchanges.at(-1)!.db.sales_exports.inserted[0]!.query;
};

const dump = (filters: SalesExportFilters) => yamlColumn("query", "Hash").dump(salesExportQuery(1n, filters));

describe("salesExportQuery", () => {
  it.each([
    ["queues-an-export-of-every-sale", {}],
    [
      "queues-an-export-with-a-date-range-and-a-product",
      { startDate: "2026-01-01", endDate: "2026-05-21", productIds: [1] },
    ],
    ["queues-an-export-from-a-date", { startDate: "2026-03-15" }],
    ["queues-an-export-up-to-a-date", { endDate: "2026-03-15" }],
    ["queues-an-export-of-one-product", { productIds: [1] }],
    ["reads-a-date-spelled-with-short-month-and-day-numbers", { startDate: "2026-01-05", endDate: "2026-02-03" }],
  ] as [string, SalesExportFilters][])("serializes %s as the YAML Rails stores", (name, filters) => {
    expect(dump(filters)).toBe(recordedQuery(name));
  });

  it("ends the range at the midnight after the end date, across a month and a year", () => {
    expect(dump({ endDate: "2025-12-31" })).toContain("lt: '2026-01-01T00:00:00Z'");
    expect(dump({ endDate: "2024-02-28" })).toContain("lt: '2024-02-29T00:00:00Z'");
  });
});
