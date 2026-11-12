// HomeController's static marketing pages: /terms, /privacy, /prohibited and /dpa. The markup is app/views/home/*.html.erb, read from the
// files; the tables below list the Ruby expressions in them that the helper calls cannot evaluate.
import { homeHelpers, type LayoutContext } from "../erb/home-layout.ts";
import { linkTo } from "../erb/html.ts";
import { type ErbTable, renderErb } from "../erb/template.ts";
import { type ActionOptions, type ActionContext, HandBackToRails, type Rendered } from "./application-controller.ts";
import { type PageMeta, renderHomePage } from "./erb-pages.ts";
import { assertFlatQuery } from "./rails-params.ts";
import type { RailsRequest } from "./rails-request.ts";

// HomeController#set_edge_cache_headers: `expires_in 1.minute, public: true, "s-maxage": 5.minutes, stale_while_revalidate: 1.hour`.
const EDGE_CACHE_CONTROL = "max-age=60, public, stale-while-revalidate=3600, s-maxage=300";
const UTM_PARAM_PREFIX = "utm_";

type HomePage = { view: string; title: string; description: string; table?: (ctx: LayoutContext) => ErbTable };

// The tarot link of prohibited.html.erb: `discover_taxonomy_url(..., host: DISCOVER_DOMAIN)`.
const TAROT_TAXONOMY = "self-improvement/spirituality/mysticism/tarot";

const HOME_PAGES: Record<string, HomePage> = {
  terms: {
    view: "home/terms.html.erb",
    title: "Gumroad terms of service",
    description: "Review the rules and guidelines for using Gumroad's services. Stay informed and compliant.",
  },
  privacy: {
    view: "home/privacy.html.erb",
    title: "Gumroad privacy policy: how we protect your data",
    description:
      "Learn how Gumroad collects, uses, and protects your personal information. Your privacy matters to us.",
  },
  prohibited: {
    view: "home/prohibited.html.erb",
    title: "Prohibited products on Gumroad",
    description:
      "Understand what products and activities are not allowed on Gumroad to comply with our policies.",
    table: ({ config }) => ({
      values: {
        [`link_to "Discover category", discover_taxonomy_url("${TAROT_TAXONOMY}", host: DISCOVER_DOMAIN)`]: () =>
          linkTo("Discover category", `${config.protocol}://${config.discoverDomain}/${TAROT_TAXONOMY}`),
      },
    }),
  },
  pricing: {
    view: "home/pricing.html.erb",
    title: "Gumroad pricing: 10% + 50¢ direct, 30% via Discover",
    description:
      "Direct sales: 10% + 50¢ per sale, $0 monthly. Discover marketplace sales: 30%. Gumroad handles sales tax worldwide as Merchant of Record, at no extra cost.",
  },
  hackathon: {
    view: "home/hackathon.html.erb",
    title: "Gumroad $100K Niche Marketplace Hackathon",
    description:
      "Build a niche marketplace using Gumroad OSS. $100K in prizes for the best marketplace ideas and implementations.",
  },
  features: {
    view: "home/features.html.erb",
    title: "Gumroad features: Sell digital products, memberships & courses",
    description:
      "Instant digital delivery, memberships and courses, pay-what-you-want pricing, affiliates, email marketing, and worldwide tax handling. No monthly fees.",
  },
  "small-bets": {
    view: "home/small_bets.html.erb",
    title: "Small Bets by Gumroad",
    description:
      "Explore the Small Bets initiative by Gumroad. Learn, experiment, and grow with small, actionable projects.",
  },
  dpa: {
    view: "home/dpa.html.erb",
    title: "Gumroad data processing addendum",
    description:
      "Gumroad's Data Processing Addendum for sellers, covering GDPR Article 28 processor terms, subprocessors, and international transfers.",
  },
};

// HomeController#edge_cacheable_request?: a GET with no cookies at all and no utm_* param (UtmLinkTracking needs the guid cookie).
// A visitor who is signed in always carries the session cookie, so the cookie test covers `user_signed_in?`.
function edgeCacheable(request: RailsRequest): boolean {
  if (request.method !== "GET" || request.cookies.size > 0) return false;
  try {
    const keys = request.queryString.split("&").map((pair) => decodeURIComponent((pair.split("=")[0] ?? "").replace(/\+/gu, " ")));
    return !keys.some((key) => key.startsWith(UTM_PARAM_PREFIX));
  } catch {
    // A malformed escape is a 400 Rails answers.
    return false;
  }
}

// The session is skipped, no guid is minted and forgery protection is off for an edge cacheable response: the pair of `bare` filters.
export const homePageOptions = (request: RailsRequest): ActionOptions => (edgeCacheable(request) ? { bare: true } : {});

export function homePage(request: RailsRequest, action: ActionContext, name: string): Promise<Rendered> {
  const page = HOME_PAGES[name];
  if (page === undefined) throw new HandBackToRails(`the home page ${name}`);
  if (request.method !== "GET") throw new HandBackToRails("a home page that is not a GET");
  // The only query reads are edge_cacheable_request?'s; a non-flat query is Rails' to parse.
  assertFlatQuery(request.queryString);
  const cacheable = edgeCacheable(request);
  return renderHomePage(
    request,
    action,
    (origin) => ({ title: page.title, description: page.description, url: `${origin}/${name}` }) satisfies PageMeta,
    (ctx) => renderErb(page.view, { helpers: homeHelpers(ctx.config, ctx.nonce), ...page.table?.(ctx) }),
    // The params are read only by edge_cacheable_request?, which runs its last test for a cookie-less GET.
    { paramsRead: request.cookies.size === 0, ...(cacheable ? { headers: { "cache-control": EDGE_CACHE_CONTROL } } : {}) },
  );
}
