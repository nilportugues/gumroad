// Taxonomy reads for Discover: Taxonomy.find_by_path (closure_tree) and
// Discover::TaxonomyPresenter#taxonomies_for_nav, with the taxonomies of the curated products when there are any.
import { Prisma } from "@prisma/client";

import { column, columnIn, selectRows, table } from "../../models/sql.ts";
import { taxonomyLabelOrNull } from "../../presenters/discover/seo.ts";
import { NotPortedError } from "../not-ported.ts";

export type TaxonomyRow = { id: bigint; parent_id: bigint | null; slug: string };

// Taxonomy.find_by_path(slugs): the root with the first slug, then a child per slug.
export async function taxonomyByPath(slugs: string[]): Promise<TaxonomyRow | null> {
  let current: TaxonomyRow | null = null;
  for (const slug of slugs) {
    const parent: Prisma.Sql =
      current === null
        ? Prisma.sql`${column("taxonomies", "parent_id")} IS NULL`
        : Prisma.sql`${column("taxonomies", "parent_id")} = ${current.id}`;
    const [row]: TaxonomyRow[] = await selectRows<TaxonomyRow>(
      Prisma.sql`SELECT ${column("taxonomies", "id")}, ${column("taxonomies", "parent_id")}, ${column("taxonomies", "slug")} FROM ${table("taxonomies")} WHERE ${parent} AND ${column("taxonomies", "slug")} = ${slug} ORDER BY ${column("taxonomies", "id")} ASC LIMIT 1`,
    );
    if (!row) return null;
    current = row;
  }
  return current;
}

type NavRow = TaxonomyRow & { recent_sales_count: number | null };

export type NavTaxonomy = { key: string; label: string | null; slug: string; parent_key: string | null };

// Taxonomy.all.eager_load(:taxonomy_stat) sorted by popularity, "other" last. Rails caches the list for an hour
// (Rails.cache); the port reads it every time.
export async function taxonomiesForNav(curatedTaxonomyIds: bigint[] = []): Promise<NavTaxonomy[]> {
  const rows = await selectRows<NavRow>(
    Prisma.sql`SELECT ${column("taxonomies", "id")}, ${column("taxonomies", "parent_id")}, ${column("taxonomies", "slug")}, (SELECT ${column("taxonomy_stats", "recent_sales_count")} FROM ${table("taxonomy_stats")} WHERE ${column("taxonomy_stats", "taxonomy_id")} = ${column("taxonomies", "id")} ORDER BY ${column("taxonomy_stats", "id")} ASC LIMIT 1) AS recent_sales_count FROM ${table("taxonomies")} ORDER BY ${column("taxonomies", "id")} ASC`,
  );
  const sortKey = (row: NavRow): [number, number, string] =>
    row.slug === "other" ? [1, 0, row.slug] : [0, -Number(row.recent_sales_count ?? 0), row.slug];
  const sorted = [...rows].sort((a, b) => {
    const [a0, a1, a2] = sortKey(a);
    const [b0, b1, b2] = sortKey(b);
    return a0 - b0 || a1 - b1 || (a2 < b2 ? -1 : a2 > b2 ? 1 : 0);
  });
  const nav = sorted.map((row) => ({
    key: String(row.id),
    label: taxonomyLabelOrNull(row.slug),
    slug: row.slug,
    parent_key: row.parent_id === null ? null : String(row.parent_id),
  }));
  if (curatedTaxonomyIds.length === 0) return nav;

  const weights = await rootWeights(curatedTaxonomyIds);
  return nav
    .map((taxonomy, index) => ({ taxonomy, index }))
    .sort((a, b) => (weights.get(b.taxonomy.slug) ?? 0) - (weights.get(a.taxonomy.slug) ?? 0) || a.index - b.index)
    .map(({ taxonomy }) => taxonomy);
}

// The `sorted_roots` of TaxonomyPresenter#taxonomies_for_nav: the root slug of each distinct curated taxonomy, the earlier
// the heavier. Rails weighs by the list's length minus the position; only the order of the weights shows, so a repeated id
// (which `find` returns once) leaves the order alone.
async function rootWeights(taxonomyIds: bigint[]): Promise<Map<string, number>> {
  const distinct = [...new Set(taxonomyIds)];
  const roots = await selectRows<{ descendant_id: bigint; slug: string }>(
    Prisma.sql`SELECT ${column("taxonomy_hierarchies", "descendant_id")}, ${column("taxonomies", "slug")} FROM ${table("taxonomy_hierarchies")} INNER JOIN ${table("taxonomies")} ON ${column("taxonomies", "id")} = ${column("taxonomy_hierarchies", "ancestor_id")} WHERE ${columnIn("taxonomy_hierarchies", "descendant_id", distinct)} AND ${column("taxonomies", "parent_id")} IS NULL`,
  );
  const slugOf = new Map(roots.map((row) => [row.descendant_id, row.slug]));
  // `find` raises RecordNotFound (a 500) for an id with no root ancestor.
  if (distinct.some((id) => !slugOf.has(id)))
    throw new NotPortedError("Taxonomy.find of a curated taxonomy without a root");
  const weights = new Map<string, number>();
  distinct.forEach((id, index) => {
    const slug = slugOf.get(id)!;
    if (!weights.has(slug)) weights.set(slug, distinct.length - index);
  });
  return weights;
}
