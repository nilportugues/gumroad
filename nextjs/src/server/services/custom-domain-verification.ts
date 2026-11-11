// CustomDomainVerificationService#process (app/services/custom_domain_verification_service.rb): does the domain, or its www variant, point at
// Gumroad by a CNAME to CUSTOM_DOMAIN_CNAME or by A records equal to those of CUSTOM_DOMAIN_CNAME / CUSTOM_DOMAIN_STATIC_IP_HOST.
import { Resolver } from "node:dns/promises";

import { getConfig } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { parseDomain } from "../models/concerns/public-suffix.ts";

const RESOLVER_TIMEOUT_MS = 5000;
const WWW_PREFIX = "www";
// Resolv returns an empty list for a name with no record of the type, where node:dns rejects with these.
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA"]);

export type DnsResolver = {
  cname(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
};

export function nodeDnsResolver(): DnsResolver {
  const resolver = new Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: 1 });
  const orEmpty = async (lookup: Promise<string[]>) => {
    try {
      return await lookup;
    } catch (error) {
      if (NO_RECORDS.has((error as { code?: string }).code ?? "")) return [];
      throw error;
    }
  };
  return {
    cname: (name) => orEmpty(resolver.resolveCname(name)),
    a: (name) => orEmpty(resolver.resolve4(name)),
  };
}

// config/initializers/custom_domain.rb
function customDomainTargets(): { cname: string; staticIpHost: string } {
  if (railsEnv() === "production") {
    return {
      cname: getConfig("CUSTOM_DOMAIN_CNAME_PROD", "domains.gumroad.com"),
      staticIpHost: getConfig("CUSTOM_DOMAIN_STATIC_IP_HOST_PROD", "production-custom-domains-static-ip.gumroad.net"),
    };
  }
  return {
    cname: getConfig("CUSTOM_DOMAIN_CNAME_STAGING", "domains-staging.gumroad.com"),
    staticIpHost: getConfig("CUSTOM_DOMAIN_STATIC_IP_HOST_STAGING", "staging-custom-domains-static-ip.gumroad.net"),
  };
}

async function sameAddresses(resolver: DnsResolver, target: string, name: string): Promise<boolean> {
  const current = [...(await resolver.a(name))].sort();
  const expected = [...(await resolver.a(target))].sort();
  return current.length === expected.length && current.every((address, index) => address === expected[index]);
}

async function cnameOrAliasConfigured(resolver: DnsResolver, name: string): Promise<boolean> {
  const targets = customDomainTargets();
  try {
    const [first] = await resolver.cname(name);
    if (first !== undefined && first === targets.cname) return true;
    return (
      (await sameAddresses(resolver, targets.cname, name)) ||
      (await sameAddresses(resolver, targets.staticIpHost, name))
    );
  } catch {
    return false;
  }
}

// #process: any failure, including a domain PublicSuffix refuses, is "not pointed at Gumroad".
export async function customDomainPointsToGumroad(
  domain: string | null,
  resolver: DnsResolver = nodeDnsResolver(),
): Promise<boolean> {
  if (domain === null) return false;
  try {
    const parsed = parseDomain(domain);
    if (parsed.domain === null) return false;
    if (parsed.trd === null || parsed.trd === WWW_PREFIX) {
      return (
        (await cnameOrAliasConfigured(resolver, parsed.domain)) ||
        (await cnameOrAliasConfigured(resolver, `${WWW_PREFIX}.${parsed.domain}`))
      );
    }
    return await cnameOrAliasConfigured(resolver, domain);
  } catch {
    return false;
  }
}
