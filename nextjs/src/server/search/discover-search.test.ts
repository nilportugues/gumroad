import { readFileSync } from "node:fs";

import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { renderSql } from "../models/runtime/quoting.ts";
import { setSqlClient } from "../models/sql.ts";
import { esJson } from "./es-json.ts";
import {
  filetypeOptions,
  partialSearchOptions,
  SellerProfileSectionParam,
  searchOptions,
  taxonomyAttributeOptions,
  type SearchDeps,
} from "./product-search.ts";
import { RubyError, type Params } from "./ruby-params.ts";
import {
  filterableTaxonomyAttributes,
  normalizeSearchParamValues,
  searchProductsWithFacets,
  taxonomySelfAndDescendantIds,
  type TaxonomyAttributeRow,
  validFilterTokens,
} from "./search-products.ts";
import { setEsSender, type EsRequest } from "./transport.ts";

// Replays discover-search.golden.json, recorded by generate-discover-search-golden.rb from the real
// Product::Searchable and SearchProducts against Elasticsearch 7.17 (through a proxy that kept the
// bytes on the wire): each body must be the one Rails sent, and the recorded answers must give the
// result Rails got.
type Exchange = { method: string; path: string; query: string | null; body: string; status: number; response: Record<string, unknown> };
type Outcome = { error?: { class: string; message: string } } & Record<string, unknown>;
type SearchCase = { name: string; params: Params; via: string; outcome: Outcome; exchanges: Exchange[]; sql: string[] };
type ProductsCase = { name: string; params: Params; outcome: Outcome; exchanges: Exchange[]; sql: string[] };
type NormalizeCase = { name: string; params: Params; result: Params & { error?: { class: string; message: string } } };
type Golden = {
  index: string;
  valid_filter_tokens: string[];
  valid_filter_tokens_sql: string[];
  taxonomy_descendants: Record<string, { ids: number[]; sql: string[] }>;
  taxonomy_attributes: Array<Omit<TaxonomyAttributeRow, "id">>;
  search_cases: SearchCase[];
  search_products_cases: ProductsCase[];
  normalize_cases: NormalizeCase[];
};
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/discover-search.golden.json", import.meta.url), "utf8")) as Golden;

// travel_to(FIXED_NOW) in the generator
const FIXED_NOW = new Date("2026-10-01T12:00:00Z");

const attributeRows: TaxonomyAttributeRow[] = golden.taxonomy_attributes.map((row, index) => ({ id: index + 1, ...row }));

const deps: SearchDeps = {
  now: () => FIXED_NOW,
  async taxonomySelfAndDescendantIds(taxonomyId) {
    const found = golden.taxonomy_descendants[String(taxonomyId)];
    if (!found) throw new RubyError("ActiveRecord::RecordNotFound", `Couldn't find Taxonomy with 'id'=${String(taxonomyId)}`);
    return found.ids;
  },
};

const productsDeps = {
  ...deps,
  async filterableTaxonomyAttributes(taxonomyId: unknown) {
    return attributeRows.filter((row) => Number(row.taxonomy_id) === Number(taxonomyId) && row.active && ["enum", "boolean"].includes(row.value_type));
  },
};

function build(params: Params): Params {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === "object" && value !== null && "$section" in value ? new SellerProfileSectionParam((value as { $section: unknown[] }).$section) : value,
    ]),
  );
}

let restore: (() => void) | undefined;
afterEach(() => restore?.());

function replay(exchanges: Exchange[]): EsRequest[] {
  const sent: EsRequest[] = [];
  const queue = [...exchanges];
  restore = setEsSender(async (request) => {
    sent.push(request);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${request.method} ${request.path}`);
    return { status: next.status, body: next.response };
  });
  return sent;
}

describe("Product::Searchable query builders", () => {
  it("has recorded cases", () => {
    expect(golden.search_cases.length).toBeGreaterThanOrEqual(100);
  });

  it.each(golden.search_cases.map((c) => [c.name, c] as const))("%s", async (_name, recorded) => {
    const params = build(recorded.params);
    const body = async () => {
      switch (recorded.via) {
        case "search":
          return searchOptions(params, deps);
        case "filetype":
          return filetypeOptions(params, deps);
        case "taxonomy_attribute":
          return taxonomyAttributeOptions(params, deps);
        default:
          return partialSearchOptions(params);
      }
    };
    const error = recorded.outcome.error;
    if (error && recorded.exchanges.length === 0) {
      await expect(body()).rejects.toMatchObject({ rubyClass: error.class, message: error.message });
      return;
    }
    expect(esJson(await body())).toBe(recorded.exchanges[0]!.body);
  });
});

describe("search_products", () => {
  it.each(golden.search_products_cases.map((c) => [c.name, c] as const))("%s", async (_name, recorded) => {
    const sent = replay(recorded.exchanges);
    const result = await searchProductsWithFacets(build(recorded.params), productsDeps);
    expect(sent.map((request) => request.body)).toEqual(recorded.exchanges.map((exchange) => exchange.body));
    const { product_ids: ids, ...facets } = result;
    expect(facets).toEqual(recorded.outcome);
    const hits = (recorded.exchanges[0]!.response.hits as { hits: Array<{ _id: string }> }).hits;
    expect(ids).toEqual(hits.map((hit) => hit._id));
  });
});

describe("normalize_search_param_values!", () => {
  const tokens = async () => new Set(golden.valid_filter_tokens);
  it.each(golden.normalize_cases.map((c) => [c.name, c] as const))("%s", async (_name, recorded) => {
    const result = await normalizeSearchParamValues(recorded.params, { validFilterTokens: tokens });
    expect(result).toEqual(recorded.result);
  });
});

describe("statements", () => {
  function statements(rows: (sql: string) => unknown[]): string[] {
    const seen: string[] = [];
    setSqlClient(() => ({
      $queryRaw: (async (query: Prisma.Sql) => {
        const text = renderSql(query);
        seen.push(text);
        return rows(text);
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));
    return seen;
  }

  it("reads the descendants through closure_tree's join, as Taxonomy#self_and_descendants does", async () => {
    const recorded = golden.taxonomy_descendants["1"]!;
    const seen = statements((sql) => (sql.includes("INNER JOIN") ? recorded.ids.map((id) => ({ id })) : [{ id: 1 }]));
    expect(await taxonomySelfAndDescendantIds(1)).toEqual(recorded.ids);
    expect(seen).toEqual(recorded.sql.length === 1 ? [golden.search_cases.find((c) => c.name === "taxonomy_id with descendants")!.sql[0], recorded.sql[0]] : []);
  });

  it("raises RecordNotFound for an unknown taxonomy", async () => {
    statements(() => []);
    await expect(taxonomySelfAndDescendantIds("99999")).rejects.toMatchObject({ message: "Couldn't find Taxonomy with 'id'=99999" });
  });

  it("reads the filterable attributes of a taxonomy with the statements search_products sends", async () => {
    const recorded = golden.search_products_cases.find((c) => c.name === "a taxonomy with filterable attributes")!;
    const seen = statements((sql) => (sql.includes("taxonomy_attributes") ? attributeRows.filter((row) => row.taxonomy_id === 2 && row.active) : [{ id: 2 }]));
    const attributes = await filterableTaxonomyAttributes("2");
    expect(attributes.map((a) => a.name)).toEqual(["format", "animated"]);
    expect(seen).toEqual(recorded.sql);
  });

  it("reads the valid filter tokens with Rails' statement", async () => {
    const seen = statements(() => attributeRows.filter((row) => row.active));
    expect([...(await validFilterTokens())].sort()).toEqual(golden.valid_filter_tokens);
    expect(seen).toEqual(golden.valid_filter_tokens_sql);
  });
});
