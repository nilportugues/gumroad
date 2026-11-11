import { describe, expect, it } from "vitest";

import { customDomainPointsToGumroad, type DnsResolver } from "./custom-domain-verification";

const CNAME_TARGET = "domains-staging.gumroad.com";
const STATIC_IP_HOST = "staging-custom-domains-static-ip.gumroad.net";
const GUMROAD_ADDRESSES = ["203.0.113.7", "203.0.113.8"];

function resolverOf(records: { cname?: Record<string, string[]>; a?: Record<string, string[]> }): DnsResolver & {
  queried: string[];
} {
  const queried: string[] = [];
  return {
    queried,
    cname: (name) => {
      queried.push(`CNAME ${name}`);
      return Promise.resolve(records.cname?.[name] ?? []);
    },
    a: (name) => {
      queried.push(`A ${name}`);
      return Promise.resolve(records.a?.[name] ?? []);
    },
  };
}

const gumroadAddresses = { [CNAME_TARGET]: GUMROAD_ADDRESSES, [STATIC_IP_HOST]: GUMROAD_ADDRESSES };

describe("customDomainPointsToGumroad", () => {
  it("accepts a subdomain whose CNAME is the custom domain target", async () => {
    const resolver = resolverOf({ cname: { "shop.example.com": [CNAME_TARGET] } });
    expect(await customDomainPointsToGumroad("shop.example.com", resolver)).toBe(true);
  });

  it("accepts a name whose addresses equal those of the target, in any order", async () => {
    const resolver = resolverOf({ a: { ...gumroadAddresses, "shop.example.com": [...GUMROAD_ADDRESSES].reverse() } });
    expect(await customDomainPointsToGumroad("shop.example.com", resolver)).toBe(true);
  });

  it("accepts a name whose addresses equal those of the static IP host", async () => {
    const resolver = resolverOf({
      a: {
        [CNAME_TARGET]: ["198.51.100.1"],
        [STATIC_IP_HOST]: GUMROAD_ADDRESSES,
        "shop.example.com": GUMROAD_ADDRESSES,
      },
    });
    expect(await customDomainPointsToGumroad("shop.example.com", resolver)).toBe(true);
  });

  it("rejects a name whose addresses differ from the target", async () => {
    const resolver = resolverOf({ a: { ...gumroadAddresses, "shop.example.com": ["198.51.100.1"] } });
    expect(await customDomainPointsToGumroad("shop.example.com", resolver)).toBe(false);
  });

  it("checks the apex and its www variant for a domain with no subdomain", async () => {
    const resolver = resolverOf({ cname: { "www.example.com": [CNAME_TARGET] } });
    expect(await customDomainPointsToGumroad("example.com", resolver)).toBe(true);
    expect(resolver.queried.slice(0, 1)).toEqual(["CNAME example.com"]);
  });

  it("treats a lookup that throws as not configured", async () => {
    const resolver: DnsResolver = {
      cname: () => Promise.reject(new Error("timeout")),
      a: () => Promise.reject(new Error("timeout")),
    };
    expect(await customDomainPointsToGumroad("shop.example.com", resolver)).toBe(false);
  });

  it("treats a domain PublicSuffix refuses as not configured without asking DNS", async () => {
    const resolver = resolverOf({});
    expect(await customDomainPointsToGumroad("com", resolver)).toBe(false);
    expect(await customDomainPointsToGumroad("", resolver)).toBe(false);
    expect(await customDomainPointsToGumroad(null, resolver)).toBe(false);
    expect(resolver.queried).toEqual([]);
  });
});
