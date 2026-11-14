// Port of config/domain.rb. Pure: takes the environment instead of reading process.env, so the proxy
// and the tests can build any environment's configuration.
export type RailsEnv = "production" | "staging" | "test" | "development";

export type DomainConfig = {
  protocol: string;
  domain: string;
  assetDomain: string;
  rootDomain: string;
  shortDomain: string;
  discoverDomain: string;
  apiDomain: string;
  thirdPartyAnalyticsDomain: string;
  validRequestHosts: string[];
  validApiRequestHosts: string[];
  validDiscoverRequestHost: string;
  railsEnv: RailsEnv;
};

type EnvironmentDefaults = Omit<DomainConfig, "railsEnv" | "validDiscoverRequestHost"> & { validDiscoverHost: string };

function defaultsFor(env: RailsEnv, devLanePort: string): EnvironmentDefaults {
  switch (env) {
    case "production":
      return {
        protocol: "https",
        domain: "gumroad.com",
        assetDomain: "assets.gumroad.com",
        rootDomain: "gumroad.com",
        shortDomain: "gum.co",
        discoverDomain: "gumroad.com",
        apiDomain: "api.gumroad.com",
        thirdPartyAnalyticsDomain: "gumroad-analytics.com",
        validRequestHosts: ["gumroad.com", "app.gumroad.com"],
        validApiRequestHosts: ["api.gumroad.com"],
        validDiscoverHost: "gumroad.com",
      };
    case "staging":
      return {
        protocol: "https",
        domain: "staging.gumroad.com",
        assetDomain: "staging-assets.gumroad.com",
        rootDomain: "staging.gumroad.com",
        shortDomain: "staging.gum.co",
        discoverDomain: "staging.gumroad.com",
        apiDomain: "api.staging.gumroad.com",
        thirdPartyAnalyticsDomain: "staging.gumroad-analytics.com",
        validRequestHosts: ["staging.gumroad.com", "app.staging.gumroad.com"],
        validApiRequestHosts: ["api.staging.gumroad.com"],
        validDiscoverHost: "staging.gumroad.com",
      };
    case "test":
      return {
        protocol: "http",
        domain: "app.test.gumroad.com:31337",
        assetDomain: "test.gumroad.com:31337",
        rootDomain: "test.gumroad.com:31337",
        shortDomain: "short-domain.test.gumroad.com:31337",
        discoverDomain: "test.gumroad.com:31337",
        apiDomain: "api.test.gumroad.com:31337",
        thirdPartyAnalyticsDomain: "analytics.test.gumroad.com",
        validRequestHosts: ["127.0.0.1", "app.test.gumroad.com", "test.gumroad.com"],
        validApiRequestHosts: ["api.test.gumroad.com"],
        validDiscoverHost: "test.gumroad.com",
      };
    case "development":
      return {
        protocol: "http",
        domain: `localhost:${devLanePort}`,
        assetDomain: `app.localhost:${devLanePort}`,
        rootDomain: `localhost:${devLanePort}`,
        shortDomain: `s.localhost:${devLanePort}`,
        discoverDomain: `localhost:${devLanePort}`,
        apiDomain: `api.localhost:${devLanePort}`,
        thirdPartyAnalyticsDomain: `analytics.localhost:${devLanePort}`,
        validRequestHosts: ["app.localhost", "localhost", `app.localhost:${devLanePort}`, `localhost:${devLanePort}`],
        validApiRequestHosts: ["api.localhost", `api.localhost:${devLanePort}`],
        validDiscoverHost: "localhost",
      };
  }
}

export function domainConfig(env: Record<string, string | undefined>): DomainConfig {
  const railsEnv = (env.RAILS_ENV ?? "development") as RailsEnv;
  const defaults = defaultsFor(railsEnv, env.DEV_LANE_PORT ?? "3000");
  const customDomain = env.CUSTOM_DOMAIN;
  const customProtocol = (env.CUSTOM_PROTOCOL ?? "").trim();

  const config: DomainConfig = {
    ...defaults,
    protocol: customProtocol === "" ? defaults.protocol : customProtocol,
    domain: customDomain ?? defaults.domain,
    assetDomain: env.ASSET_DOMAIN ?? defaults.assetDomain,
    rootDomain: customDomain ?? defaults.rootDomain,
    shortDomain: env.CUSTOM_SHORT_DOMAIN ?? defaults.shortDomain,
    validRequestHosts: [...defaults.validRequestHosts],
    validApiRequestHosts: [...defaults.validApiRequestHosts],
    discoverDomain: defaults.discoverDomain,
    validDiscoverRequestHost: defaults.validDiscoverHost,
    railsEnv,
  };

  if (customDomain !== undefined) {
    config.validRequestHosts.push(customDomain);
    config.validApiRequestHosts.push(`api.${customDomain}`);
    if ((env.BRANCH_DEPLOYMENT ?? "") !== "") config.validApiRequestHosts.push(customDomain);
    config.discoverDomain = customDomain;
    config.validDiscoverRequestHost = customDomain;
  }
  if (railsEnv === "development" && env.LOCAL_PROXY_DOMAIN !== undefined) {
    config.validRequestHosts.push(env.LOCAL_PROXY_DOMAIN.replace(/https?:\/\//u, ""));
  }
  return config;
}

// Rails' `config.asset_host` is set in every environment but test.
export function assetHost(config: DomainConfig): string | null {
  return config.railsEnv === "test" ? null : `${config.protocol}://${config.assetDomain}`;
}
