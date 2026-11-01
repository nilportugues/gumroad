// Read side of app/services/subdomain_redirector_service.rb: the redirect table Rails caches from
// Redis, and the lookup ApplicationController#redirect_to_custom_subdomain runs on every request.
// `update` stays in Rails (the admin form).
import type { RailsCache } from "../cache/rails-cache.ts";
import { railsCache } from "../cache/rails-cache.ts";
import { domainConfig } from "../page-props/domain.ts";
import { getNamespacedRedis } from "../infra/redis.ts";
import { fullpath, type RailsRequest } from "../controllers/rails-request.ts";

const CACHE_KEY = "subdomain_redirects_cache_key";
const REDIS_KEY = "subdomain_redirects_config";

export type SubdomainRedirectorDeps = {
  cache: () => RailsCache;
  readConfig: () => Promise<string | null>;
  protectedHosts: () => string[];
};

const defaultDeps: SubdomainRedirectorDeps = {
  cache: railsCache,
  readConfig: () => getNamespacedRedis("subdomain_redirect_namespace").get(REDIS_KEY),
  // VALID_API_REQUEST_HOSTS + VALID_REQUEST_HOSTS
  protectedHosts: () => {
    const config = domainConfig(process.env);
    return [...config.validApiRequestHosts, ...config.validRequestHosts];
  },
};

let currentDeps = defaultDeps;

export function setSubdomainRedirectorDepsForTesting(next: Partial<SubdomainRedirectorDeps> | null): void {
  currentDeps = next === null ? defaultDeps : { ...defaultDeps, ...next };
}

class RedisReadError extends Error {}

// String#strip: leading and trailing whitespace and NUL.
const strip = (value: string) => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g, "");

// A Map, as Marshal loads a Ruby Hash, so a fresh parse and a cache hit look the same.
export function parseRedirectConfig(config: string | null, protectedHosts: string[]): Map<string, string> {
  const redirects = new Map<string, string>();
  if (config === null || strip(config) === "") return redirects;
  for (const line of config.split("\n")) {
    const index = line.indexOf("=");
    const host = strip(index === -1 ? line : line.slice(0, index));
    const location = index === -1 ? "" : strip(line.slice(index + 1));
    if (host === "" || location === "" || protectedHosts.includes(host)) continue;
    redirects.set(host.toLowerCase(), location);
  }
  return redirects;
}

// Cached without expiry, like Rails; a Redis failure answers "no redirects" and caches nothing.
export async function subdomainRedirects(deps: SubdomainRedirectorDeps = currentDeps): Promise<Map<unknown, unknown>> {
  try {
    const value = await deps.cache().fetch(CACHE_KEY, {}, async () => {
      let config: string | null;
      try {
        config = await deps.readConfig();
      } catch (error) {
        throw new RedisReadError(String(error));
      }
      return parseRedirectConfig(config, deps.protectedHosts());
    });
    return value instanceof Map ? value : new Map();
  } catch (error) {
    if (error instanceof RedisReadError) return new Map();
    throw error;
  }
}

export async function redirectUrlFor(request: RailsRequest): Promise<string | undefined> {
  const path = fullpath(request);
  const key = path === "/" ? request.host : request.host + path;
  const location = (await subdomainRedirects()).get(key);
  return typeof location === "string" ? location : undefined;
}
