// Discover::CanonicalUrlPresenter, Discover::TagPageMetaPresenter, Discover::CategoryPagePresenter and
// UrlService.discover_full_path. The constants come from discover-data.generated.json
// (scripts/dump-discover-data.rb).
import { toQuery } from "../../controllers/rails-query.ts";
import { domainConfig } from "../../page-props/domain.ts";
import data from "./discover-data.generated.json" with { type: "json" };

const SCHEMA_ORG_CONTEXT = "https://schema.org";
export const DISCOVER_INDEX_PATH = "/discover";
const SINGLE_UNIT_CURRENCIES = new Set<string>(data.single_unit_currencies);
const TAXONOMY_LABELS: Record<string, string> = data.taxonomy_labels;
const META: { titles: Record<string, unknown>; descriptions: Record<string, unknown> } = data.meta_tags as never;

export const taxonomyLabelOrNull = (slug: string): string | null => (Object.hasOwn(TAXONOMY_LABELS, slug) ? TAXONOMY_LABELS[slug]! : null);
export const taxonomyLabel = (slug: string): string => TAXONOMY_LABELS[slug] ?? slug;
export const botUserAgents: ReadonlySet<string> = new Set(data.bot_user_agents);

const present = (value: unknown): boolean => value !== null && value !== undefined && String(value).trim() !== "";

// UrlService.discover_full_path
export function discoverFullPath(taxonomyPath: string, queryParams: Record<string, string> = {}): string {
  const { protocol, discoverDomain } = domainConfig(process.env);
  const entries = Object.fromEntries(Object.entries(queryParams).filter(([, value]) => value !== null && value !== undefined));
  const query = toQuery(entries);
  // Addressable keeps a relative path as given: a taxonomy path has no leading slash, the index path has one.
  const path = taxonomyPath.startsWith("/") ? taxonomyPath : `/${taxonomyPath}`;
  return `${protocol}://${discoverDomain}${path}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}

const CANONICAL_KEYS = ["sort", "query", "min_price", "max_price", "rating", "tags", "filetypes"] as const;

type SearchParams = Record<string, unknown>;

// Discover::CanonicalUrlPresenter.canonical_url
export function canonicalUrl(params: SearchParams): string {
  if (["taxonomy", "query", "tags"].every((key) => !present(Array.isArray(params[key]) ? (params[key] as unknown[]).join("") : params[key]))) {
    return discoverFullPath(DISCOVER_INDEX_PATH);
  }
  const path = present(params.taxonomy) ? String(params.taxonomy) : DISCOVER_INDEX_PATH;
  const valid: Record<string, string> = {};
  for (const key of CANONICAL_KEYS) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    const canonical = Array.isArray(value) ? value.map(String).sort().join(",") : String(value);
    if (present(canonical)) valid[key] = canonical;
  }
  return discoverFullPath(path, valid);
}

// ActionView number_with_delimiter on an integer
export const numberWithDelimiter = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

// Array#to_sentence (en)
function toSentence(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

// String#% with named references
function format(template: string, options: Record<string, string>): string {
  return template.replace(/%\{(\w+)\}/gu, (_, name: string) => options[name] ?? "");
}

// Discover::TagPageMetaPresenter#fetch_discover_meta
function fetchDiscoverMeta(section: "titles" | "descriptions", key: string, options: Record<string, string>, fallback = ""): string {
  const value = Object.hasOwn(META[section], key) ? META[section][key] : undefined;
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return format(value, options);
}

const firstTagKey = (tags: string[]) => tags[0]!.replace(/\s+/gu, " ").trim().replaceAll(" ", "-").toLowerCase();

export function tagPageTitle(tags: string[]): string {
  const fallback = fetchDiscoverMeta("titles", "default", { tags: tags.join(", ") });
  return tags.length === 1 ? fetchDiscoverMeta("titles", firstTagKey(tags), {}, fallback) : fallback;
}

export function tagPageMetaDescription(tags: string[], resultCount: number): string {
  const count = numberWithDelimiter(resultCount);
  const fallback = fetchDiscoverMeta("descriptions", "default", { result_count: count, tags: toSentence(tags) });
  return tags.length === 1 ? fetchDiscoverMeta("descriptions", firstTagKey(tags), { result_count: count }, fallback) : fallback;
}

export type CardForSeo = { name: unknown; url: unknown; price_cents?: unknown; currency_code?: unknown };

const labelsOf = (slugs: string[]) => slugs.map(taxonomyLabel);

// Discover::CategoryPagePresenter
export const categoryPage = {
  title: (taxonomyPath: string) => `${labelsOf(taxonomyPath.split("/")).join(" » ")} — digital products by independent creators | Gumroad`,
  metaDescription(taxonomyPath: string, total: number): string {
    const last = labelsOf(taxonomyPath.split("/")).at(-1);
    return `Browse ${numberWithDelimiter(total)} ${last} products from independent creators on Gumroad. Discover the best free and premium ${last} digital downloads.`;
  },
  breadcrumbListJsonLd(taxonomyPath: string): Record<string, unknown> {
    const slugs = taxonomyPath.split("/");
    const labels = labelsOf(slugs);
    const items = [{ name: "Discover", url: discoverFullPath(DISCOVER_INDEX_PATH) }, ...slugs.map((_, index) => ({ name: labels[index]!, url: discoverFullPath(`/${slugs.slice(0, index + 1).join("/")}`) }))];
    return {
      "@context": SCHEMA_ORG_CONTEXT,
      "@type": "BreadcrumbList",
      itemListElement: items.map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.name, item: item.url })),
    };
  },
  itemListJsonLd(taxonomyPath: string, total: number | null, products: CardForSeo[]): Record<string, unknown> | null {
    if (products.length === 0) return null;
    return {
      "@context": SCHEMA_ORG_CONTEXT,
      "@type": "ItemList",
      name: labelsOf(taxonomyPath.split("/")).at(-1),
      numberOfItems: total,
      itemListElement: products.map((product, index) => {
        const item: Record<string, unknown> = { "@type": "Product", name: product.name, url: product.url };
        if (product.price_cents !== null && product.price_cents !== undefined) {
          const currency = String(product.currency_code ?? "");
          item.offers = {
            "@type": "Offer",
            // price_cents is in the currency's minor unit except for single-unit currencies (JPY).
            price: Number(product.price_cents) / (SINGLE_UNIT_CURRENCIES.has(currency.toLowerCase()) ? 1 : 100),
            priceCurrency: currency.toUpperCase(),
          };
        }
        return { "@type": "ListItem", position: index + 1, item };
      }),
    };
  },
};
