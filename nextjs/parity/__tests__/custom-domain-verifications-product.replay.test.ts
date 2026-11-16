import { describeErbLayoutReplay } from "../src/erb-layout";

// Replays spec/requests/custom_domain_verifications_product_parity_spec.rb. DNS is answered from the zone the spec stubs on Resolv::DNS
// (keep the two in sync); the test environment's custom domain targets are the staging ones.
const CNAME_TARGET = "domains-staging.gumroad.com";
const STATIC_IP_HOST = "staging-custom-domains-static-ip.gumroad.net";
const INTERNAL_GUMROAD_DOMAIN = "test.gumroad.net";

const zone = {
  cname: {
    "configured-shop.example.com": CNAME_TARGET,
    "-bad.example.com": CNAME_TARGET,
    "taken-shop.example.com": CNAME_TARGET,
    [`shop.${INTERNAL_GUMROAD_DOMAIN}`]: CNAME_TARGET,
  },
  a: {
    [CNAME_TARGET]: ["203.0.113.7"],
    [STATIC_IP_HOST]: ["203.0.113.7"],
    "aliased-shop.example.org": ["203.0.113.7"],
  },
};

describeErbLayoutReplay("Custom domain verification of a product's domain", {
  routeFlags: "nextjs_custom_domain_verify",
  seed: {},
  select: () => true,
  spec: "custom_domain_verifications_product_parity_spec",
  env: { CUSTOM_DOMAIN_DNS_TEST_ZONE: JSON.stringify(zone) },
});
