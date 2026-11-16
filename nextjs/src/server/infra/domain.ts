import { railsEnv, type RailsEnv } from "./rails-env.ts";

// The part of config/domain.rb the infra adapters need (CSP, asset host). Routing-specific
// constants (valid request hosts, CORS origins, discover domain) belong to the routing proxy.

type EnvDomains = { protocol: string; domain: string; assetDomain: string; rootDomain: string; anycableHost: string };

function domainsFor(env: RailsEnv, devLanePort: string): EnvDomains {
  switch (env) {
    case "production":
      return { protocol: "https", domain: "gumroad.com", assetDomain: "assets.gumroad.com", rootDomain: "gumroad.com", anycableHost: "cable.gumroad.com" };
    case "staging":
      return {
        protocol: "https",
        domain: "staging.gumroad.com",
        assetDomain: "staging-assets.gumroad.com",
        rootDomain: "staging.gumroad.com",
        anycableHost: "cable.staging.gumroad.com",
      };
    case "test":
      return {
        protocol: "http",
        domain: "app.test.gumroad.com:31337",
        assetDomain: "test.gumroad.com:31337",
        rootDomain: "test.gumroad.com:31337",
        anycableHost: "cable.test.gumroad.com",
      };
    case "development":
      return {
        protocol: "http",
        domain: `localhost:${devLanePort}`,
        assetDomain: `app.localhost:${devLanePort}`,
        rootDomain: `localhost:${devLanePort}`,
        anycableHost: "cable.localhost",
      };
  }
}

export type DomainConfig = EnvDomains & { env: RailsEnv; assetHost: string | undefined };

export function domainConfig(env: RailsEnv = railsEnv()): DomainConfig {
  const base = domainsFor(env, process.env.DEV_LANE_PORT ?? "3000");
  const customDomain = process.env.CUSTOM_DOMAIN;
  const customProtocol = (process.env.CUSTOM_PROTOCOL ?? "").trim();
  const protocol = customProtocol === "" ? base.protocol : customProtocol;
  const assetDomain = process.env.ASSET_DOMAIN ?? base.assetDomain;
  return {
    env,
    protocol,
    domain: customDomain ?? base.domain,
    assetDomain,
    rootDomain: customDomain ?? base.rootDomain,
    anycableHost: base.anycableHost,
    // config.asset_host is set in development, staging and production, not in test.
    assetHost: env === "test" ? undefined : `${protocol}://${assetDomain}`,
  };
}
