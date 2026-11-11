// Port of the host constraints in config/routes.rb (lib/*_constraint.rb, Subdomain, CustomDomain.find_by_host)
// as a pure function. Parts that need the database (does this username or custom domain exist?) are
// returned as lookups for the caller instead of being answered here.
import { parse } from "tldts";

import type { DomainConfig } from "@/server/page-props/domain";

// Subdomain::USERNAME_REGEXP
const USERNAME_PATTERN = "[a-z0-9-]+";
const WWW_PREFIX = "www";

export type HostClassification = {
  // `constraints(host: /#{THIRD_PARTY_ANALYTICS_DOMAIN}/o)`: unanchored and unescaped, as in Ruby.
  thirdPartyAnalytics: boolean;
  // DiscoverDomainConstraint
  discover: boolean;
  // ApiDomainConstraint: every host matches in development.
  api: boolean;
  // GumroadDomainConstraint
  gumroad: boolean;
  // Subdomain.find_seller_by_hostname: the label to look up (by external_id when numeric, else username).
  sellerSubdomain: { externalId: string } | { username: string } | null;
  // CustomDomain.find_by_host: alive custom_domains rows to try, in order. Null when the host is not a valid domain.
  customDomainLookup: string[] | null;
};

const hostOnly = (hostWithPort: string) => hostWithPort.replace(/:\d+$/u, "");

export function sellerSubdomain(hostname: string, config: DomainConfig): HostClassification["sellerSubdomain"] {
  // Rails strips the port from ROOT_DOMAIN in development and test, since request.host has none.
  const domain = config.railsEnv === "development" || config.railsEnv === "test" ? hostOnly(config.rootDomain) : config.rootDomain;
  if (!new RegExp(`^${USERNAME_PATTERN}.${domain}$`).test(hostname)) return null;
  const subdomain = hostname.split(".", 2)[0] ?? "";
  if (/^[0-9]+$/u.test(subdomain)) return { externalId: subdomain };
  // Usernames store underscores; subdomains spell them with hyphens.
  return { username: subdomain.replace(/-/gu, "_") };
}

export function customDomainLookup(hostname: string): string[] | null {
  const parsed = parse(hostname, { allowPrivateDomains: true });
  if (parsed.isIp || parsed.domain === null) return null;
  if (!parsed.subdomain || parsed.subdomain === WWW_PREFIX) return [parsed.domain, `${WWW_PREFIX}.${parsed.domain}`];
  return [hostname];
}

// `hostname` is request.host: no port.
export function classifyHost(hostname: string, config: DomainConfig): HostClassification {
  return {
    thirdPartyAnalytics: new RegExp(config.thirdPartyAnalyticsDomain).test(hostname),
    discover: hostname === config.validDiscoverRequestHost,
    api: config.railsEnv === "development" || config.validApiRequestHosts.includes(hostname),
    gumroad: config.validRequestHosts.includes(hostname),
    sellerSubdomain: sellerSubdomain(hostname, config),
    customDomainLookup: customDomainLookup(hostname),
  };
}
