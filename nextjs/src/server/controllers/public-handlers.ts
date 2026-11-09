// The small public endpoints that are not pages: RobotsController, LlmsController, FaviconsController, AcmeChallengesController,
// IndexnowKeysController, PublicController#crossdomain and GithubStarsController. routes.json marks them with a `handler`; the
// proxy rewrites them to /gr-public/<handler> (app/gr-public/[action]/route.ts), which lands here.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { db } from "../../lib/db.ts";
import { railsMessageVerifierGenerate, railsMessageVerifierVerified } from "../auth/message-verifier.ts";
import { classifyHost } from "../../lib/navigation/proxy/hosts.ts";
import { railsCache } from "../cache/rails-cache.ts";
import { getConfig } from "../infra/config.ts";
import { getNamespacedRedis, getRedis } from "../infra/redis.ts";
import { railsRoot } from "../infra/rails-env.ts";
import { storageConfig } from "../infra/storage.ts";
import { isAccountActive, Users } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import { userByDomain } from "../page-props/storefront/seller-host.ts";
import { PAGE_URL_HEADER } from "../page-props/render-state.ts";
import { apiV2Response } from "./api-v2/base.ts";
import "./api-v2/index.ts";
import { type ActionContext, type ActionOptions, type ActionResult, HandBackToRails, processAction, type Rendered } from "./application-controller.ts";
import { mobileResponse } from "./mobile-api.ts";
import { internalResponse } from "./internal-api.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { computeDiscount } from "./offer-codes.ts";
import { chargeData, licenseKeyLookupData, paypalChargeData } from "./public-data.ts";
import { internalAdminResponse } from "./internal-admin/index.ts";
import { impersonate, redirectToStripeDashboard } from "./internal-admin/admin-web.ts";
import { assertFlatQuery } from "./rails-params.ts";
import { queryParam, type RailsRequest, railsRequest } from "./rails-request.ts";
import { esJson } from "../search/es-json.ts";
import { urlRedirectsAction } from "./url-redirects/deliveries.ts";
import { utmLinkRedirect } from "./utm-link-tracking.ts";
import { wishlistUnsubscribe } from "./wishlist-unsubscribe.ts";

const TEXT = "text/plain; charset=utf-8";
const API_V2_HANDLER = "api-v2";
const INTERNAL_ADMIN_HANDLER = "internal-admin";

// RobotsController
const ROBOTS_CACHE_TTL_SECONDS = 3600;
const ROBOTS_STALE_WHILE_REVALIDATE_SECONDS = 86_400;
const ROBOTS_SITEMAPS_KEY = "sitemap_configs";
const ROBOTS_DISALLOWED_PATHS = ["/purchases/"];
const STOREFRONT_BINGBOT_CRAWL_DELAY_SECONDS = 10;
// GithubStarsController
const GITHUB_STARS_CACHE_KEY = "github_stars_antiwork/gumroad";
const GITHUB_STARS_MAX_AGE_SECONDS = 3600;
// AcmeChallengesController
const MAX_ACME_TOKEN_LENGTH = 64;
const VALID_ACME_TOKEN = /^[A-Za-z0-9_-]+$/u;

const storefrontHost = (request: RailsRequest) => !domainConfig(process.env).validRequestHosts.includes(request.host);

// RobotsService#sitemap_configs: the S3 listing it caches for a week is Rails' to build.
async function sitemapConfigs(request: RailsRequest): Promise<string[]> {
  if (storefrontHost(request)) return [];
  const cached = await getNamespacedRedis("robots_redis_namespace").get(ROBOTS_SITEMAPS_KEY);
  if (cached === null || cached === "") throw new HandBackToRails("robots.txt without cached sitemaps");
  return JSON.parse(cached) as string[];
}

// RobotsService#user_agent_rules and app/views/robots/index.erb
function robots(request: RailsRequest, sitemaps: string[]): Rendered {
  const disallow = ROBOTS_DISALLOWED_PATHS.map((rule) => `Disallow: ${rule}`);
  const rules = [...(storefrontHost(request) ? ["User-agent: bingbot", `Crawl-delay: ${STOREFRONT_BINGBOT_CRAWL_DELAY_SECONDS}`, ...disallow, ""] : []), "User-agent: *", ...disallow];
  const body = `${rules.map((rule) => `${rule}\n`).join("")}\n${sitemaps.map((sitemap) => `${sitemap}\n`).join("")}`;
  const cacheControl = `max-age=${ROBOTS_CACHE_TTL_SECONDS}, public, stale-while-revalidate=${ROBOTS_STALE_WHILE_REVALIDATE_SECONDS}`;
  return { status: 200, body, contentType: TEXT, headers: { "cache-control": cacheControl }, paramsRead: true };
}

// app/views/llms/index.erb has no ERB tags: it is served as it is.
function llms(): Rendered {
  return { status: 200, body: readFileSync(path.join(railsRoot(), "app/views/llms/index.erb"), "utf8"), contentType: TEXT, paramsRead: true };
}

// app/views/public/crossdomain.xml.erb
function crossdomain(): Rendered {
  const body = `<?xml version="1.0"?>\n<!DOCTYPE cross-domain-policy SYSTEM "http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd">\n<cross-domain-policy>\n  <allow-access-from domain="${storageConfig().s3Bucket}.s3.amazonaws.com" />\n</cross-domain-policy>\n`;
  return { status: 200, body, contentType: "application/xml; charset=utf-8", paramsRead: true };
}

// FaviconsController#owner_by_domain: the seller of the host, or the seller of the product a custom domain sells.
async function ownerOfHost(hostname: string) {
  const user = await userByDomain(hostname);
  if (user) return user;
  // CustomDomain.find_by_host
  for (const domain of classifyHost(hostname, domainConfig(process.env)).customDomainLookup ?? []) {
    const custom = await db.customDomain.findFirst({ where: { deleted_at: null, domain }, orderBy: { id: "asc" } });
    if (!custom) continue;
    const product = custom.product_id === null ? null : await db.link.findFirst({ where: { id: custom.product_id } });
    return product?.user_id == null ? null : db.user.findFirst({ where: { id: product.user_id } });
  }
  return null;
}

async function favicon(request: RailsRequest): Promise<ActionResult> {
  const user = storefrontHost(request) ? await ownerOfHost(request.host) : null;
  if (user && isAccountActive(Users.load(user))) return { status: 302, location: await avatarUrl(user) };
  const body = readFileSync(path.join(railsRoot(), "public/favicon.ico"));
  return {
    status: 200,
    body: new Uint8Array(body),
    contentType: "image/x-icon",
    headers: {
      "cache-control": "no-cache",
      "content-disposition": "inline; filename=\"favicon.ico\"; filename*=UTF-8''favicon.ico",
      "content-transfer-encoding": "binary",
    },
  };
}

// AcmeChallengesController#show
async function acmeChallenge(token: string): Promise<Rendered> {
  const empty = (status: number): Rendered => ({ status, body: "", contentType: "text/html", paramsRead: true });
  if (token === "" || token.length > MAX_ACME_TOKEN_LENGTH || !VALID_ACME_TOKEN.test(token)) return empty(400);
  let content: string | null = null;
  try {
    content = await getRedis("main").get(`acme_challenge:${token}`);
  } catch {
    // A stalled read is "no challenge staged" (REDIS_TRANSPORT_ERRORS).
  }
  return content === null || content === "" ? empty(404) : { status: 200, body: content, contentType: TEXT, paramsRead: true };
}

// IndexnowKeysController#show: ActiveSupport::SecurityUtils.secure_compare against GlobalConfig.get("INDEXNOW_KEY").
function indexnowKey(candidate: string): Rendered {
  const key = getConfig("INDEXNOW_KEY");
  const given = Buffer.from(candidate);
  const known = Buffer.from(key ?? "");
  if (key !== undefined && key !== "" && given.length === known.length && timingSafeEqual(given, known)) return { status: 200, body: key, contentType: TEXT, paramsRead: true };
  return { status: 404, body: "", contentType: "text/plain", paramsRead: true };
}

// GithubStarsController#show: a cache miss makes Rails call the GitHub API, so it stays Rails'.
async function githubStars(): Promise<Rendered> {
  const stars = await railsCache().read(GITHUB_STARS_CACHE_KEY);
  if (stars === undefined) throw new HandBackToRails("github_stars without a cached count");
  return { status: 200, body: esJson({ stars: stars as number | null }), contentType: "application/json; charset=utf-8", headers: { "cache-control": `max-age=${GITHUB_STARS_MAX_AGE_SECONDS}, public` } };
}

// EmbeddedJavascriptsController#analytics and app/views/embedded_javascripts/analytics.js.erb
const ANALYTICS_VERIFIER = "product_analytics_view";
const ANALYTICS_SCRIPT_TOKEN_PURPOSE = "external_landing_page_script";
const ANALYTICS_VIEW_TOKEN_PURPOSE = "external_landing_page_view";
const ANALYTICS_VIEW_TOKEN_TTL_MS = 10 * 60_000;

// ActionView::Helpers::JavaScriptHelper#escape_javascript
const JS_ESCAPES: Record<string, string> = { "\\": "\\\\", "</": "<\\/", "\r\n": "\\n", "\n": "\\n", "\r": "\\n", '"': '\\"', "'": "\\'", "`": "\\`", $: "\\$", "\u2028": "&#x2028;", "\u2029": "&#x2029;" };
const escapeJavascript = (value: string) => value.replace(/(\\|<\/|\r\n|[\n\r"'`$\u2028\u2029])/gu, (match) => JS_ESCAPES[match]!);

async function analyticsScript(request: RailsRequest): Promise<Rendered> {
  assertFlatQuery(request.queryString);
  // Only the template's own format renders: for an HTML request Rails raises MissingTemplate.
  const accept = request.headers.get("accept") ?? "";
  if (accept.trim() !== "*/*" && !/javascript/u.test(accept)) throw new HandBackToRails("analytics script requested as something other than a script");
  const token = queryParam(request, "token");
  let product: { id: bigint; unique_permalink: string | null } | null = null;
  if (typeof token === "string" && token !== "") {
    const payload = railsMessageVerifierVerified(ANALYTICS_VERIFIER, token, ANALYTICS_SCRIPT_TOKEN_PURPOSE);
    const id = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).product_id : undefined;
    if (typeof id === "number") product = await db.link.findFirst({ where: { id, deleted_at: null }, select: { id: true, unique_permalink: true } });
  }
  const referrer = request.headers.get("referer");
  const viewToken =
    product && referrer !== null && referrer !== ""
      ? railsMessageVerifierGenerate(ANALYTICS_VERIFIER, { product_id: Number(product.id), source_url: referrer, event_id: randomUUID() }, ANALYTICS_VIEW_TOKEN_PURPOSE, { expiresAt: new Date(Date.now() + ANALYTICS_VIEW_TOKEN_TTL_MS) })
      : "";
  const template = readFileSync(path.join(railsRoot(), "app/views/embedded_javascripts/analytics.js.erb"), "utf8");
  const body = template
    .replace("<%= j @product&.unique_permalink.to_s %>", () => escapeJavascript(product?.unique_permalink ?? ""))
    .replace("<%= j @analytics_token.to_s %>", () => escapeJavascript(viewToken));
  return { status: 200, body, contentType: "application/javascript; charset=utf-8", headers: { "cache-control": "no-cache" }, paramsRead: true };
}

type Handler = { options?: ActionOptions; run(request: RailsRequest, url: URL, action: ActionContext): Promise<ActionResult> };

const HANDLERS: Record<string, Handler> = {
  robots: { options: { bare: true }, run: async (request) => robots(request, await sitemapConfigs(request)) },
  llms: { run: async () => llms() },
  crossdomain: { run: async () => crossdomain() },
  favicon: { run: (request) => favicon(request) },
  // The bytes are Rails' own: AcmeChallengesController#mask_token shadows the CSRF one, so the XSRF-TOKEN cookie is the first two and last two bytes of the global token around "...".
  acme_challenge: {
    options: { xsrfCookieBytes: (token) => Buffer.concat([token.subarray(0, 2), Buffer.from("..."), token.subarray(-2)]) },
    run: (_request, url) => acmeChallenge(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")),
  },
  indexnow: { run: async (_request, url) => indexnowKey(decodeURIComponent(url.pathname.slice(1).replace(/\.txt$/u, ""))) },
  github_stars: { run: () => githubStars() },
  wishlist_unsubscribe: { run: (request) => wishlistUnsubscribe(request) },
  utm_tracking: { run: (_request, url) => utmLinkRedirect(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")) },
  analytics_js: { run: (request) => analyticsScript(request) },
  charge_data: { options: { optOutOfCsp: true }, run: (request) => chargeData(request) },
  license_key_lookup_data: { options: { optOutOfCsp: true }, run: (request) => licenseKeyLookupData(request) },
  paypal_charge_data: { options: { optOutOfCsp: true }, run: (request) => paypalChargeData(request) },
  admin_impersonate: { run: (request, url, action) => impersonate(request, url, action) },
  admin_stripe_dashboard: { run: (request, url, action) => redirectToStripeDashboard(request, url, action) },
  // OfferCodesController#compute_discount
  compute_discount: { run: (request, _url, action) => computeDiscount(request, railsLoggedInUser(action.context) !== null) },
  url_redirects: { run: (_request, _url, action) => urlRedirectsAction(action) },
};

export async function publicHandlerResponse(incoming: Request, name: string): Promise<Response> {
  // Api::Mobile: every method, and a body to read.
  if (name === "mobile") return mobileResponse(incoming);
  // The v2 API routes of every method, which carry bodies (controllers/api-v2/base.ts).
  if (name === API_V2_HANDLER) return apiV2Response(incoming);
  // Api::Internal::Admin: every method, bearer-token authenticated (controllers/internal-admin).
  if (name === INTERNAL_ADMIN_HANDLER) return internalAdminResponse(incoming);
  // Api::Internal GETs (controllers/internal-api.ts).
  if (name === "internal") return internalResponse(incoming);
  const handler = HANDLERS[name];
  const target = incoming.headers.get(PAGE_URL_HEADER);
  if (handler === undefined || target === null) return new Response(null, { status: 404 });
  const host = incoming.headers.get("x-forwarded-host") ?? incoming.headers.get("host") ?? "localhost";
  const protocol = incoming.headers.get("x-forwarded-proto") ?? "http";
  const url = new URL(target, `${protocol}://${host}`);
  const request = new Request(url, { method: incoming.method, headers: incoming.headers });
  return processAction(request, handler.options ?? {}, (action) => handler.run(railsRequest(request), url, action));
}
