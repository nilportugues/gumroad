// DiscoverTaxonomyConstraint (lib/discover_taxonomy_constraint.rb) behind DiscoverDomainConstraint: the
// request is on the discover host and its path is exactly one of the taxonomies' paths. Rails builds the list
// once per process; reading the table per request sees a new taxonomy at once instead.
import { classifyHost } from "../lib/navigation/proxy/hosts.ts";
import { domainConfig } from "./page-props/domain.ts";
import { taxonomyByPath } from "./page-props/discover/taxonomies.ts";

export async function isTaxonomyPath(url: URL): Promise<boolean> {
  if (!classifyHost(url.hostname, domainConfig(process.env)).discover) return false;
  if (!url.pathname.startsWith("/") || url.pathname === "/") return false;
  const slugs = url.pathname.slice(1).split("/");
  if (slugs.some((slug) => slug === "")) return false;
  return (await taxonomyByPath(slugs)) !== null;
}
