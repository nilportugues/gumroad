// The Events concern's `create_user_event` for the dashboard page views (followers_view,
// workflows_view, emails_view): an `events` row describing the request.
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import type { RequestContext } from "@/server/auth/context";

import { railsLoggedInUser } from "../../auth/resolve.ts";
import { geoIpLookup } from "../../infra/geo-ip.ts";
import { isInvalidUriError, rubyUriParse } from "../../models/concerns/ruby-uri.ts";
import { column, execute, table } from "../../models/sql.ts";
import { isMobile } from "../shared.ts";
import type { RenderState } from "../../controllers/application-controller.ts";
import { rackParam, type QuerySource } from "./support.ts";

const EVENTS = "events";
const DEFAULT_REFERRER = "direct";
const REFERRER_MAX_LENGTH = 190;
const REFERRER_DOMAIN_FOR_GUMROAD_RECOMMENDED_PRODUCTS = "recommended_by_gumroad";
// Event flags (visit_id): flag n is bit n - 1.
const FLAG_WAS_PRODUCT_RECOMMENDED = 2 ** 1;
const FLAG_ON_CUSTOM_DOMAIN = 2 ** 4;
const FLAG_FROM_MULTI_OVERLAY = 2 ** 5;
const FLAG_FROM_SEO = 2 ** 6;
// FlagShihTzu::TRUE_VALUES
const FLAG_TRUE_VALUES = ["1", "t", "T", "true", "TRUE", "on", "ON"];
// ActiveModel::Type::Boolean::FALSE_VALUES
const BOOLEAN_FALSE_VALUES = ["0", "f", "F", "false", "FALSE", "off", "OFF"];
const SEO_REFERRER = /(google|bing|yahoo|yandex|duckduckgo)(\.[a-z]{2,3})(\.[a-z]{2})?$/i;

// Referrer.extract_domain
export function referrerDomain(url: string | null): string {
  if (url === null || /^\s*$/u.test(url) || url === DEFAULT_REFERRER) return DEFAULT_REFERRER;
  try {
    let unescaped = url;
    try {
      unescaped = decodeURIComponent(url);
    } catch {
      // URI::DEFAULT_PARSER.unescape leaves a malformed escape alone.
    }
    const host = rubyUriParse(unescaped.replace(/[^\x00-\x7f]/gu, "").replace(/\s+/gu, "")).host?.toLowerCase();
    if (!host) return DEFAULT_REFERRER;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch (error) {
    if (isInvalidUriError(error)) return DEFAULT_REFERRER;
    throw error;
  }
}

// ActionDispatch::RemoteIp with the default trusted proxies. REMOTE_ADDR is the socket peer, which Next
// copies into X-Forwarded-For when the request has none.
const TRUSTED_PROXIES = [/^127\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^fe[89ab][0-9a-f]:/i];
export function remoteIp(headers: Headers): string | null {
  const forwarded = (headers.get("x-forwarded-for") ?? "").trim().split(/[,\s]+/u).filter((ip) => ip !== "");
  const ips = [...forwarded].reverse();
  return ips.find((ip) => !TRUSTED_PROXIES.some((proxy) => proxy.test(ip))) ?? ips.at(-1) ?? null;
}

const castBoolean = (value: string | undefined): boolean | null => (value === undefined || value === "" ? null : !BOOLEAN_FALSE_VALUES.includes(value));

function param(request: QuerySource, name: string): string | undefined {
  const value = rackParam(request, name);
  return typeof value === "string" ? value : undefined;
}

export type EventSource = {
  context: RequestContext;
  headers: Headers;
  url: URL;
  state: RenderState | null;
};

// Events#create_user_event(name): nothing while impersonating.
export async function createUserEvent(name: string, { context, headers, url, state }: EventSource): Promise<void> {
  if (context.impersonatedUser) return;
  const user = railsLoggedInUser(context);
  const query: QuerySource = { queryString: url.search.replace(/^\?/, "") };

  const ip = remoteIp(headers);
  const geo = geoIpLookup(ip);
  const userAgent = headers.get("user-agent");
  const requestReferrer = headers.get("referer");
  const referrers = (() => {
    const value = rackParam(query, "referrer");
    return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((entry) => !/^\s*$/u.test(entry));
  })();
  let referrer: string | null = referrers.at(-1) ?? requestReferrer;
  if (referrer !== null && !/^\s*$/u.test(referrer)) referrer = referrer.replace(/[^\x00-\x7f]/gu, "").slice(0, REFERRER_MAX_LENGTH);

  const cookies = new Map((headers.get("cookie") ?? "").split(/;\s*/u).filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  const signupReferrer = state?.signupReferrer;
  const wasProductRecommended = FLAG_TRUE_VALUES.includes(param(query, "was_product_recommended") ?? "");
  let visitId = 0;
  if (wasProductRecommended) visitId |= FLAG_WAS_PRODUCT_RECOMMENDED;
  if (FLAG_TRUE_VALUES.includes(param(query, "from_multi_overlay") ?? "")) visitId |= FLAG_FROM_MULTI_OVERLAY;
  if (signupReferrer && SEO_REFERRER.test(signupReferrer)) visitId |= FLAG_FROM_SEO;
  // on_custom_domain: false for these dashboard views.
  void FLAG_ON_CUSTOM_DOMAIN;

  const plugins = param(query, "plugins");
  const now = new Date();
  const values: Record<string, unknown> = {
    visit_id: visitId,
    ip_address: ip,
    event_name: name,
    user_id: user?.id ?? null,
    link_id: null,
    created_at: now,
    updated_at: now,
    referrer,
    parent_referrer: param(query, "parent_referrer") ?? null,
    browser: userAgent,
    is_mobile: isMobile(state?.mobileParam, userAgent),
    view_url: param(query, "view_url") ?? url.pathname,
    ip_country: geo?.countryName ?? null,
    ip_longitude: 0,
    ip_latitude: 0,
    is_modal: castBoolean(param(query, "is_modal")),
    browser_fingerprint: createHash("md5").update([userAgent ?? "", plugins ?? ""].join(",")).digest("hex"),
    browser_guid: cookies.get("_gumroad_guid") ?? state?.mintedGuid ?? null,
    referrer_domain: wasProductRecommended ? REFERRER_DOMAIN_FOR_GUMROAD_RECOMMENDED_PRODUCTS : referrerDomain(referrer),
    ip_state: geo?.regionName ?? null,
    price_cents: null,
  };
  const names = Object.keys(values);
  await execute(
    Prisma.sql`INSERT INTO ${table(EVENTS)} (${Prisma.join(names.map((name) => column(EVENTS, name)))}) VALUES (${Prisma.join(names.map((name) => values[name]))})`,
  );
}
