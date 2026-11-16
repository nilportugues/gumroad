// Port of app/sidekiq/update_taxonomy_stats_job.rb: for every root taxonomy, the sales, creators and products counts of its whole
// subtree and its sales of the last 30 days are read from the purchases index and stored on its TaxonomyStat. An Elasticsearch answer
// with a shape the golden does not cover (a cardinality that is null, not a number or past a 32-bit column) hands back, which is safe
// because the job overwrites each stat from scratch.
// Golden: __fixtures__/update-taxonomy-stats-job.golden.json (scripts/golden/update-taxonomy-stats-job.rb).
import { Prisma, type Taxonomy, type TaxonomyStat } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setAssociation } from "../../server/models/concerns/rails-validations.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { findOneBy } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { TAXONOMY, TaxonomyStats } from "../../server/models/taxonomy-stat.ts";
import { PurchaseSearchService, type PurchaseSearchResult } from "../../server/search/purchase-search.ts";

import { modelJob } from "./support/job-deps.ts";

const TAXONOMIES = "taxonomies";
const HIERARCHIES = "taxonomy_hierarchies";
const RECENT_SALES_WINDOW_DAYS = 30;
const MAX_INTEGER_COLUMN = 2 ** 31 - 1;

// Ruby raises these on the shapes the job reads without checking; the message is what Sidekiq's retry set would show.
class RubyError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// `taxonomy.descendant_ids` (closure_tree): the subtree's ids, nearest generation first, without the node itself.
async function descendantIds(taxonomy: Taxonomy): Promise<bigint[]> {
  const rows = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT ${column(TAXONOMIES, "id")} FROM ${table(TAXONOMIES)} INNER JOIN ${table(HIERARCHIES)} ON ${column(TAXONOMIES, "id")} = ${column(HIERARCHIES, "descendant_id")} WHERE ${column(HIERARCHIES, "ancestor_id")} = ${taxonomy.id} AND (${column(TAXONOMIES, "id")} != ${String(taxonomy.id)}) ORDER BY ${Prisma.raw("`taxonomy_hierarchies`.generations")} ASC`,
  );
  return rows.map((row) => BigInt(row.id));
}

// `search_result["hits"]["total"]["value"]`
function totalOf(result: PurchaseSearchResult): number {
  const hits = result.response.hits;
  if (hits === undefined) throw new RubyError("NoMethodError", "undefined method '[]' for nil");
  const total = hits.total;
  if (total === undefined) throw new RubyError("NoMethodError", "undefined method '[]' for nil");
  if (typeof total === "number") throw new RubyError("TypeError", "no implicit conversion of String into Integer");
  return integerColumn(total.value, "hits.total.value");
}

// `search_result.aggregations.<name>.value`
function cardinalityOf(result: PurchaseSearchResult, name: string): number {
  const aggregations = result.response.aggregations;
  if (aggregations === undefined) throw new RubyError("NoMethodError", `undefined method '${name}' for nil`);
  const aggregation = (aggregations as Record<string, { value?: unknown } | undefined>)[name];
  return integerColumn(aggregation?.value, `aggregations.${name}.value`);
}

// An Integer column casts a Float by truncating; null, other types and values past the column are left to Rails.
function integerColumn(raw: unknown, what: string): number {
  // The answer is parsed with Ruby's float semantics, so a whole-number Float arrives wrapped.
  const value = raw instanceof RubyFloat ? raw.value : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(Math.trunc(value)) > MAX_INTEGER_COLUMN)
    throw new HandBackToRuby(`${what} is not a number the stat column takes`);
  return Math.trunc(value);
}

export const updateTaxonomyStatsJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  const roots = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`taxonomies`.*")} FROM ${table(TAXONOMIES)} WHERE ${column(TAXONOMIES, "parent_id")} IS NULL`,
  );
  for (const row of roots) {
    const taxonomy = castRow<Taxonomy>("Taxonomy", row);
    const taxonomyIds = [taxonomy.id, ...(await descendantIds(taxonomy))];

    // `TaxonomyStat.find_or_create_by!(taxonomy:)`: a new row is saved with its column defaults and keeps the taxonomy it was built for.
    const found = await findOneBy<TaxonomyStat>("TaxonomyStat", "taxonomy_id", taxonomy.id);
    let stat;
    if (found) stat = TaxonomyStats.load(found);
    else {
      stat = TaxonomyStats.build({ taxonomy_id: taxonomy.id });
      setAssociation(stat, TAXONOMY.name, taxonomy.id, taxonomy);
      await TaxonomyStats.saveBang(stat, { now: deps.now });
    }

    const shared = {
      taxonomy: taxonomyIds,
      state: "successful",
      size: 0,
      exclude_unreversed_chargedback: true,
      exclude_refunded: true,
      exclude_bundle_product_purchases: true,
      track_total_hits: true,
    };
    const totals = await PurchaseSearchService.process({
      ...shared,
      aggs: {
        creators_count: { cardinality: { field: "seller_id" } },
        products_count: { cardinality: { field: "product_id" } },
      },
    });
    const sales_count = totalOf(totals);
    const creators_count = cardinalityOf(totals, "creators_count");
    const products_count = cardinalityOf(totals, "products_count");

    const recent = await PurchaseSearchService.process({
      ...shared,
      created_on_or_after: ago({ days: RECENT_SALES_WINDOW_DAYS }, deps.now()),
    });
    const recent_sales_count = totalOf(recent);

    stat.assign({ sales_count, creators_count, products_count, recent_sales_count });
    await TaxonomyStats.saveBang(stat, { now: deps.now });
  }
});

export const updateTaxonomyStatsJob = updateTaxonomyStatsJobWith();
