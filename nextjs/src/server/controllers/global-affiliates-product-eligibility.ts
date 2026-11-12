// GlobalAffiliates::ProductEligibilityController#show (GET /global_affiliates/product_eligibility/*url,
// app/controllers/global_affiliates/product_eligibility_controller.rb): the global affiliate page's "paste a product link" check.
//
// Rails fetches the pasted product's public JSON through SsrfFilter and answers `{ success: false, error }` for every failure of
// that path. Node answers the URLs that fail before any request is made: a blank one, one without an http(s) scheme and
// one that names a host outside Gumroad's own registrable domains. A URL that could be ours (the fetch, and the JSON it reads
// back) hands back whole.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { productsAffiliatedPolicy } from "../policies/products-affiliated.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, accountEmailRequired } from "./seller-json.ts";

const INVALID_URL = "Please provide a valid Gumroad product URL";
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/u;

// Registrable domain of one of Gumroad's hosts (ROOT_DOMAIN, SHORT_DOMAIN, DOMAIN), the way PublicSuffix.domain(ignore_private: true)
// would give it for the domains Gumroad runs on: `gumroad.com`, `gum.co`.
function registrableDomain(host: string): string {
  return host.split(".").slice(-2).join(".");
}

function gumroadDomains(): Set<string> {
  const config = domainConfig(process.env);
  return new Set(
    [config.rootDomain, config.shortDomain, config.domain].map((domain) =>
      registrableDomain(domain.split(":")[0]!.toLowerCase()),
    ),
  );
}

// true: Rails refuses the URL before it connects. false: the URL may be ours.
function refusedBeforeFetch(url: string): boolean {
  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined || !["http", "https"].includes(scheme)) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new HandBackToRails("a URL Node cannot parse");
  }
  if (host === "") throw new HandBackToRails("a URL with no host");
  const ours = gumroadDomains();
  return ![...ours].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function show(input: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null) throw new HandBackToRails("a signed-out request");
  const missingEmail = accountEmailRequired(input);
  if (missingEmail) return missingEmail;
  const denied = await authorizeJson(input, (context) => authorize(productsAffiliatedPolicy.index, context));
  if (denied) return denied;

  const url = input.routeParams.url ?? "";
  if (refusedBeforeFetch(url)) return json({ success: false, error: INVALID_URL });
  throw new HandBackToRails("fetching the product's public JSON");
}

registerMutations({
  method: "GET",
  pattern: "/global_affiliates/product_eligibility/*url",
  json: true,
  skipForgeryProtection: true,
  run: show,
});
