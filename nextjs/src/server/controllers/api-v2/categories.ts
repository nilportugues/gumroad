// Api::V2::CategoriesController
import { taxonomiesForNav, type NavTaxonomy } from "../../page-props/discover/taxonomies.ts";
import { json, PUBLIC_READ_SCOPES, registerApiV2 } from "./base.ts";

const CACHE_SECONDS = 3600;

export type ApiCategory = { id: number; name: string; label: string; path: string; parent_id: number | null };

// Discover::TaxonomyPresenter#categories_by_id (private), keyed by the taxonomy id.
export async function categoriesById(): Promise<Map<string, ApiCategory>> {
  const taxonomies = await taxonomiesForNav();
  const byKey = new Map(taxonomies.map((taxonomy) => [taxonomy.key, taxonomy]));
  const paths = new Map<string, string>();
  const pathFor = (taxonomy: NavTaxonomy): string => {
    const known = paths.get(taxonomy.key);
    if (known !== undefined) return known;
    const parent = taxonomy.parent_key === null ? undefined : byKey.get(taxonomy.parent_key);
    const path = parent ? `${pathFor(parent)}/${taxonomy.slug}` : taxonomy.slug;
    paths.set(taxonomy.key, path);
    return path;
  };
  return new Map(
    taxonomies.map((taxonomy) => [
      taxonomy.key,
      { id: Number(taxonomy.key), name: taxonomy.slug, label: taxonomy.label ?? taxonomy.slug, path: pathFor(taxonomy), parent_id: taxonomy.parent_key === null ? null : Number(taxonomy.parent_key) },
    ]),
  );
}

// Ruby's String#<=> compares bytes.
const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export async function categoriesForApi(): Promise<ApiCategory[]> {
  return [...(await categoriesById()).values()].sort((a, b) => byteCompare(a.path, b.path));
}

registerApiV2({
  method: "GET",
  pattern: "/v2/categories",
  scopes: PUBLIC_READ_SCOPES,
  async run() {
    return json({ success: true, categories: await categoriesForApi() }, 200, { "cache-control": `max-age=${CACHE_SECONDS}, private` });
  },
});
