import { Client } from "@elastic/elasticsearch";

import { railsEnv } from "./rails-env";

// Port of config/initializers/elasticsearch.rb and the index names each Elasticsearch::Model sets.
// The local stack runs ES 7.9, so this stays on the v7 client.
//
// Query builders are not ported here. Each slice ports the builder it needs (Product::Searchable's
// search options, PurchaseSearchService, InstallmentSearchService, AudienceMember::Searchable,
// AdminSearchService, BundleSearchProductsService) as a pure function returning the request body,
// proven by golden vectors: the Ruby builder's body for fixed params, compared as JSON.

const MAX_RETRIES = 5;
// GC pauses on the cluster last several seconds; a shorter timeout fails inside them on every retry.
const REQUEST_TIMEOUT_MS = 15_000;

let client: Client | undefined;

export function getElasticsearch(): Client {
  if (!client) {
    const node = process.env.ELASTICSEARCH_HOST;
    if (node === undefined) throw new Error('key not found: "ELASTICSEARCH_HOST"');
    client = new Client({ node, maxRetries: MAX_RETRIES, requestTimeout: REQUEST_TIMEOUT_MS });
  }
  return client;
}

export function useEsAliases(): boolean {
  const env = railsEnv();
  return env === "production" || (env === "staging" && process.env.BRANCH_DEPLOYMENT !== "true");
}

export type SearchModel = "Link" | "Purchase" | "Installment" | "ConfirmedFollowerEvent" | "ProductPageView" | "AudienceMember";

const BASE_INDEX_NAMES: Record<SearchModel, string> = {
  Link: "products",
  Purchase: "purchases",
  Installment: "installments",
  ConfirmedFollowerEvent: "confirmed_follower_events",
  ProductPageView: "product_page_views",
  AudienceMember: "audience_members",
};

// prefix_for_branch_apps_es_index.rb renames these five (not AudienceMember) on staging previews.
const BRANCH_APP_MODELS = new Set<SearchModel>(["Link", "Purchase", "Installment", "ConfirmedFollowerEvent", "ProductPageView"]);

export function indexName(model: SearchModel): string {
  if (railsEnv() === "staging" && process.env.BRANCH_DEPLOYMENT === "true" && BRANCH_APP_MODELS.has(model)) {
    // String#parameterize on a CamelCase class name is just its downcase.
    return `branch-app-${process.env.DATABASE_NAME ?? ""}__${model.toLowerCase()}`;
  }
  return `${BASE_INDEX_NAMES[model]}${process.env.ES_INDEX_SUFFIX ?? ""}`;
}

// ProductPageView.index_name_from_body: monthly indices behind an alias where aliases are used.
export function productPageViewIndexForTimestamp(timestamp: string): string {
  const base = indexName("ProductPageView");
  return useEsAliases() ? `${base}-${[...timestamp].slice(0, 7).join("")}` : base;
}
