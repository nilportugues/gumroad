// The SearchProducts controller concern (app/controllers/concerns/search_products.rb): param
// normalization and `search_products`, the product search plus the filetype and taxonomy attribute
// facets Discover and the product search endpoint render. Proven against discover-search.golden.json.
import { Prisma } from "@prisma/client";

import { selectRows, table } from "../models/sql.ts";
import { squish } from "./plaintext.ts";
import {
  filetypeOptions,
  MAX_RESULT_WINDOW,
  MAX_TAXONOMY_ATTRIBUTE_FILTER_TOKENS,
  searchOptions,
  type SearchDeps,
  searchProducts as runSearch,
  taxonomyAttributeOptions,
} from "./product-search.ts";
import { castBoolean, hasKey, intJson, isHash, isNil, type Params, present, RubyError, rubySplit, rubyStrip, rubyToS, toI } from "./ruby-params.ts";

// The first element of an Array, then only a String or Numeric survives: a crafted nested param
// collapses to the scalar the search layer expects, or nil.
export function scalarSearchValue(value: unknown): string | number | bigint | null {
  const scalar = Array.isArray(value) ? value[0] : value;
  return typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "bigint" ? scalar : null;
}

const SCALAR_KEYS = ["query", "rating", "min_price", "max_price", "sort", "recommended_by", "from", "size", "taxonomy_id", "user_id", "min_reviews_count"] as const;
const ARRAY_KEYS = ["tags", "filetypes", "ids", "exclude_ids", "taxonomy_attribute_filters", "curated_product_ids"] as const;

const downcaseSquished = (value: string): string => squish(value.replaceAll("-", " ")).toLowerCase();

export type NormalizeDeps = {
  // TaxonomyAttribute.valid_filter_tokens
  validFilterTokens: () => Promise<Set<string>>;
};

// normalize_search_param_values! on a copy of `input`. `actionControllerParams` is true for request
// params, where `search` is an ActionController::Parameters and so never a Hash: it is dropped.
export async function normalizeSearchParamValues(input: Params, deps: NormalizeDeps, options: { actionControllerParams?: boolean } = {}): Promise<Params> {
  const params: Params = { ...input };
  const hashValues = (value: unknown) => Object.values(value as Record<string, unknown>);

  if (typeof params.tags === "string") {
    params.tags = rubySplit(params.tags, ",").map(downcaseSquished);
  } else if (isHash(params.tags)) {
    params.tags = hashValues(params.tags).map((tag) => downcaseSquished(rubyToS(tag)));
  }

  if (typeof params.filetypes === "string") {
    params.filetypes = rubySplit(params.filetypes, ",").map((type) => squish(type).toLowerCase());
  }

  if (typeof params.taxonomy_attribute_filters === "string") {
    params.taxonomy_attribute_filters = rubySplit(params.taxonomy_attribute_filters, ",").map(squish);
  } else if (isHash(params.taxonomy_attribute_filters)) {
    params.taxonomy_attribute_filters = hashValues(params.taxonomy_attribute_filters).flatMap((filter) => {
      const scalar = scalarSearchValue(filter);
      return scalar === null ? [] : [squish(String(scalar))];
    });
  }

  if (typeof params.ids === "string") params.ids = rubySplit(params.ids, ",").map(rubyStrip);

  if (typeof params.curated_product_ids === "string") {
    params.curated_product_ids = rubySplit(params.curated_product_ids, ",").map(rubyStrip);
  } else if (isHash(params.curated_product_ids)) {
    params.curated_product_ids = hashValues(params.curated_product_ids);
  }

  for (const key of ARRAY_KEYS) {
    const value = params[key];
    if (!Array.isArray(value)) continue;
    params[key] = value.flatMap((element) => {
      const scalar = scalarSearchValue(element);
      return scalar === null ? [] : [String(scalar)];
    });
  }

  if (Array.isArray(params.taxonomy_attribute_filters)) {
    const validTokens = await deps.validFilterTokens();
    params.taxonomy_attribute_filters = [...new Set(params.taxonomy_attribute_filters as string[])]
      .filter((token) => validTokens.has(token))
      .slice(0, MAX_TAXONOMY_ATTRIBUTE_FILTER_TOKENS);
  }

  for (const key of SCALAR_KEYS) {
    if (hasKey(params, key)) params[key] = scalarSearchValue(params[key]);
  }

  if (hasKey(params, "taxonomy")) {
    const scalar = scalarSearchValue(params.taxonomy);
    params.taxonomy = scalar === null ? null : String(scalar);
  }

  if (present(params.from)) params.from = intJson(toI(params.from));
  if (present(params.size)) {
    const size = toI(params.size);
    params.size = size < 0n ? 0 : size > BigInt(MAX_RESULT_WINDOW) ? MAX_RESULT_WINDOW : Number(size);
  }

  if (options.actionControllerParams !== false || !isHash(params.search)) delete params.search;

  return params;
}

// ---- TaxonomyAttribute -------------------------------------------------------------------------

export type TaxonomyAttributeRow = { id: number | bigint; taxonomy_id: number | bigint; name: string; label: string; value_type: string; values: unknown; position: number; active: boolean | number };

const FILTERABLE_VALUE_TYPES = new Set(["enum", "boolean"]);
export const isFilterable = (attribute: TaxonomyAttributeRow): boolean => FILTERABLE_VALUE_TYPES.has(attribute.value_type);

function jsonValues(attribute: TaxonomyAttributeRow): unknown {
  return typeof attribute.values === "string" ? JSON.parse(attribute.values) : attribute.values;
}

// Array(values).map(&:to_s)
function normalizedOptions(attribute: TaxonomyAttributeRow): string[] {
  const values = jsonValues(attribute);
  if (isNil(values)) return [];
  if (!Array.isArray(values)) throw new RubyError("NotPortedError", "TaxonomyAttribute values that is not an Array");
  return values.map(rubyToS);
}

export function filterOptions(attribute: TaxonomyAttributeRow): string[] {
  return attribute.value_type === "boolean" ? ["true", "false"] : normalizedOptions(attribute);
}

function normalizeValue(attribute: TaxonomyAttributeRow, value: unknown): string | null {
  switch (attribute.value_type) {
    case "enum":
      return normalizedOptions(attribute).includes(rubyToS(value)) ? rubyToS(value) : null;
    case "boolean":
      return !isNil(value) && value !== "" ? String(castBoolean(value) === true) : null;
    case "number": {
      const text = rubyToS(value);
      return Number.isFinite(Number(text)) && text.trim() !== "" ? text : null;
    }
    default:
      return null;
  }
}

// String#parameterize(separator: "_"): ASCII only, since I18n.transliterate's table is not ported.
function parameterizeWithUnderscore(value: string): string {
  if (/[^\x00-\x7f]/u.test(value)) throw new RubyError("NotPortedError", "parameterize of a non-ASCII value (I18n transliteration)");
  return value
    .replace(/[^a-z0-9\-_]+/giu, "_")
    .replace(/_{2,}/gu, "_")
    .replace(/^_|_$/gmu, "")
    .toLowerCase();
}

export function filterTokenFor(attribute: TaxonomyAttributeRow, value: unknown): string | null {
  const normalized = normalizeValue(attribute, value);
  if (normalized === null || normalized === "" || !isFilterable(attribute)) return null;
  return `${attribute.name}:${parameterizeWithUnderscore(normalized)}`;
}

export const filterLabelFor = (attribute: TaxonomyAttributeRow, value: string): string => (attribute.value_type === "boolean" ? (value === "true" ? "Yes" : "No") : value);

// TaxonomyAttribute.valid_filter_tokens
export async function validFilterTokens(): Promise<Set<string>> {
  const rows = await selectRows<TaxonomyAttributeRow>(Prisma.sql`SELECT ${table("taxonomy_attributes")}.* FROM ${table("taxonomy_attributes")} WHERE ${Prisma.raw("`taxonomy_attributes`.`active` = TRUE")}`);
  const tokens = new Set<string>();
  for (const attribute of rows) {
    for (const option of filterOptions(attribute)) {
      const token = filterTokenFor(attribute, option);
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

const integerId = (value: unknown): number => Number(toI(value));

// Taxonomy.find_by(id:)&.taxonomy_attributes&.select(&:filterable?) || []
export async function filterableTaxonomyAttributes(taxonomyId: unknown): Promise<TaxonomyAttributeRow[]> {
  const id = integerId(taxonomyId);
  const taxonomies = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`taxonomies`.*")} FROM ${table("taxonomies")} WHERE ${Prisma.raw("`taxonomies`.`id`")} = ${id} LIMIT 1`);
  if (taxonomies.length === 0) return [];
  const attributes = await selectRows<TaxonomyAttributeRow>(
    Prisma.sql`SELECT ${Prisma.raw("`taxonomy_attributes`.*")} FROM ${table("taxonomy_attributes")} WHERE ${Prisma.raw("`taxonomy_attributes`.`taxonomy_id`")} = ${id} AND ${Prisma.raw("`taxonomy_attributes`.`active` = TRUE")} ORDER BY ${Prisma.raw("`taxonomy_attributes`.`position` ASC, `taxonomy_attributes`.`id` ASC")}`,
  );
  return attributes.filter(isFilterable);
}

// Taxonomy.find(id).self_and_descendants.pluck(:id): closure_tree's join, nearest generation first.
export async function taxonomySelfAndDescendantIds(taxonomyId: unknown): Promise<number[]> {
  const id = integerId(taxonomyId);
  const found = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`taxonomies`.*")} FROM ${table("taxonomies")} WHERE ${Prisma.raw("`taxonomies`.`id`")} = ${id} LIMIT 1`);
  if (found.length === 0) throw new RubyError("ActiveRecord::RecordNotFound", `Couldn't find Taxonomy with 'id'=${rubyToS(taxonomyId)}`);
  const rows = await selectRows<{ id: number | bigint }>(
    Prisma.sql`SELECT ${Prisma.raw("`taxonomies`.`id`")} FROM ${table("taxonomies")} INNER JOIN ${table("taxonomy_hierarchies")} ON ${Prisma.raw("`taxonomies`.`id` = `taxonomy_hierarchies`.`descendant_id`")} WHERE ${Prisma.raw("`taxonomy_hierarchies`.`ancestor_id`")} = ${id} ORDER BY ${Prisma.raw("`taxonomy_hierarchies`.generations ASC")}`,
  );
  return rows.map((row) => Number(row.id));
}

// ---- search_products -----------------------------------------------------------------------------

export type Bucket = Record<string, unknown>;

export type TaxonomyAttributeData = { name: string; label: string; filters: Array<{ key: string; label: string; doc_count: number }> };

export type ProductSearchResult = {
  total: number | null;
  tags_data: Bucket[];
  filetypes_data: Bucket[];
  taxonomy_attributes_data: TaxonomyAttributeData[];
  // The hits' ids in result order: elasticsearch-model's `records` loads these links and sorts them by this order.
  product_ids: string[];
};

export type SearchProductsDeps = SearchDeps & {
  filterableTaxonomyAttributes: (taxonomyId: unknown) => Promise<TaxonomyAttributeRow[]>;
};

export function defaultSearchProductsDeps(): SearchProductsDeps {
  return { now: () => new Date(), taxonomySelfAndDescendantIds, filterableTaxonomyAttributes };
}

const buckets = (aggregations: Record<string, { buckets?: Bucket[] }>, name: string): Bucket[] => {
  const aggregation = aggregations[name];
  if (!aggregation) throw new RubyError("NoMethodError", "undefined method '[]' for nil");
  return aggregation.buckets ?? [];
};

// taxonomy_attributes_data
function taxonomyAttributesData(attributes: TaxonomyAttributeRow[], aggregations: Record<string, { buckets?: Bucket[] }>): TaxonomyAttributeData[] {
  const bucketsByKey = new Map(buckets(aggregations, "taxonomy_attribute_filters").map((bucket) => [bucket.key as string, bucket]));
  const result: TaxonomyAttributeData[] = [];
  for (const attribute of attributes) {
    const filters: TaxonomyAttributeData["filters"] = [];
    for (const option of filterOptions(attribute)) {
      const token = filterTokenFor(attribute, option);
      if (token) filters.push({ key: token, label: filterLabelFor(attribute, option), doc_count: Number(bucketsByKey.get(token)?.doc_count ?? 0) });
    }
    if (filters.length > 0) result.push({ name: attribute.name, label: attribute.label, filters });
  }
  return result;
}

// SearchProducts#search_products. Rails builds the three option sets first (each one resolving the
// taxonomy's descendants), then Link.search is lazy: the product request goes out first, the filetype
// one when its facet is read, and the taxonomy attribute one only if the taxonomy has filterable attributes.
export async function searchProductsWithFacets(params: Params, deps: SearchProductsDeps = defaultSearchProductsDeps()): Promise<ProductSearchResult> {
  const filetypeBody = await filetypeOptions(params, deps);
  const taxonomyAttributeBody = present(params.taxonomy_id) ? await taxonomyAttributeOptions(params, deps) : null;
  const productBody = await searchOptions({ ...params, track_total_hits: true }, deps);

  const product = await runSearch(productBody);
  const tagsData = buckets(product.aggregations, "tags.keyword");
  const filetype = await runSearch(filetypeBody);
  const filetypesData = buckets(filetype.aggregations, "filetypes.keyword");

  let taxonomyAttributes: TaxonomyAttributeData[] = [];
  if (present(params.taxonomy_id) && taxonomyAttributeBody !== null) {
    const attributes = await deps.filterableTaxonomyAttributes(params.taxonomy_id);
    if (attributes.length > 0) taxonomyAttributes = taxonomyAttributesData(attributes, (await runSearch(taxonomyAttributeBody)).aggregations);
  }

  return { total: product.total, tags_data: tagsData, filetypes_data: filetypesData, taxonomy_attributes_data: taxonomyAttributes, product_ids: product.ids };
}
