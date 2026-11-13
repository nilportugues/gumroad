// The Rack::Attack counter (config/initializers/rack_attack.rb) for the routes Node serves, on the same Redis, keys, expiry and limits, so a
// request Node answers is counted exactly once. processAction (and pageEnvelope, for a full page load) counts each request ahead of its chain; forwardToRails un-counts a request it
// hands back (uncountRackAttack) because Rails' own middleware counts it again. This is the only counter: counting anywhere else double-counts.
// rack-attack-throttles.test.ts fails when a routes.json entry matches a rule that is not in RULES.
//
// Rack::Attack runs every rule in declaration order and stops at the first one over its limit, so a tripped rule leaves the later ones uncounted.
import { createHash } from "node:crypto";

import { db } from "../../lib/db.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { getRedis } from "../infra/redis.ts";
import { isValidEmailFormat } from "../models/user.ts";

import { HandBackToRails, rackResponse } from "./application-controller.ts";
import { parseBody, parseNestedQuery, type Params } from "./rails-body.ts";
import { type RailsRequest, railsRequest } from "./rails-request.ts";
import { resolveRequestAuth } from "./signed-in-filters.ts";

const EXPONENTIAL_BACKOFF_BASE = 8;
const SECONDS_PER_MINUTE = 60;
const TOO_MANY_REQUESTS = 429;
const LOCALHOST_ADDRESSES = new Set(["127.0.0.1", "::1"]);
const KEY_PREFIX = "rack::attack";

// The parts of Rack::Attack::Request the rules read.
export type RackRequest = {
  method: string;
  path: string;
  host: string;
  remoteIp: string;
  // Rack's `req.GET`, and `req.POST` (form bodies only: a JSON body is not form data to Rack).
  query: Params;
  form: Params;
  // `req.json_params`: the body parsed as JSON, {} when it is not.
  json: unknown;
  mediaType: string | null;
  // `req.env["HTTP_AUTHORIZATION"]`.
  authorization: string | null;
  // `req.params` raises Rack::QueryParser::InvalidParameterError or QueryLimitError: the `invalid_params` rule counts it, and every rule that
  // reads a parameter skips it (rackParams throws RackParamsInvalid) as the exponential-backoff wrapper's rescue does.
  invalidParams: boolean;
  // `req.env["warden"]&.user&.id`: the signed-in user's id, resolved when a rule asks for it.
  wardenUserId(): Promise<string | null>;
};

class RackParamsInvalid extends Error {}

export type Throttle = {
  name: string;
  limit: number;
  period: number;
  discriminator(request: RackRequest): Promise<string | null> | string | null;
  // Inside `if Rails.env.production?` in rack_attack.rb.
  productionOnly?: boolean;
};

// Staging and test skip these rules in Rails; RACK_ATTACK_PRODUCTION_RULES=1 turns them on to prove them against a recording.
const productionRulesOn = () => railsEnv() === "production" || process.env.RACK_ATTACK_PRODUCTION_RULES === "1";
const productionOnly = (rules: Throttle[]): Throttle[] => rules.map((rule) => ({ ...rule, productionOnly: true }));

export type Throttled = { name: string; period: number; epochTime: number };

export type RackStore = {
  // INCRBY 1 then EXPIRE, in one pipeline; resolves with the count.
  increment(key: string, expiresIn: number): Promise<number>;
  decrement(key: string): Promise<void>;
};

const redisStore: RackStore = {
  async increment(key, expiresIn) {
    const replies = await getRedis("rackAttack").pipeline().incrby(key, 1).expire(key, expiresIn).exec();
    return Number(replies?.[0]?.[1] ?? 1);
  },
  async decrement(key) {
    await getRedis("rackAttack").decr(key);
  },
};

// Rack::Attack.throttle_with_exponential_backoff: the base rule, then levels 2..max at `rpm * level` per 8**level seconds.
function backoff(
  name: string,
  requests: number,
  period: number,
  maxLevel: number,
  discriminator: Throttle["discriminator"],
): Throttle[] {
  const rpm = (requests / period) * SECONDS_PER_MINUTE;
  const tiers: Throttle[] = [{ name, limit: requests, period, discriminator }];
  for (let level = 2; level <= maxLevel; level += 1)
    tiers.push({
      name: `${name}/${level}`,
      limit: rpm * level,
      period: EXPONENTIAL_BACKOFF_BASE ** level,
      discriminator,
    });
  return tiers;
}

// The discriminator is shared by every tier, so it runs once per request.
function memoized(discriminator: Throttle["discriminator"]): Throttle["discriminator"] {
  const seen = new WeakMap<RackRequest, Promise<string | null> | string | null>();
  return (request) => {
    if (!seen.has(request)) seen.set(request, discriminator(request));
    return seen.get(request)!;
  };
}

const PASSWORD_RESET_PATH = /^\/(?:users|mobile)\/forgot_password(?:\.[^/]+)?$/u;
const LANDING_PRODUCTS_PATH = /^\/(?:[^/]+\/)?landing\/products$/u;
const PRODUCTS_SEARCH_PATH = /^\/products\/search(?:\.[^/]+)?$/u;
const RESEND_RECEIPT_PATH = /^(\/(?:purchases|service_charges)\/[^/]+\/resend_receipt)(?:\.[^/]+)?$/u;
const CHAT_MESSAGES_PATH = /^\/communities\/[^/]+\/chat_messages$/u;
const COMMENTS_PATH = /^\/posts\/.+\/comments$/u;
const COMMENT_PATH = /^\/posts\/.+\/comments\/.+$/u;
const TWO_FACTOR_BY_USER = [
  ["/two-factor", "POST"],
  ["/two-factor/resend_authentication_token", "POST"],
  ["/two-factor/verify", null],
  ["/two-factor/switch_to_email", "POST"],
  ["/two-factor/switch_to_recovery", "POST"],
  ["/two-factor/switch_to_authenticator", "POST"],
] as const;

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Rack::Request#params: the query string, then the form body over it.
const rackParams = (request: RackRequest): Params => {
  if (request.invalidParams) throw new RackParamsInvalid();
  return { ...request.query, ...request.form };
};

// `"#{value}"` for the values a parameter can hold.
function interpolate(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  throw new HandBackToRails("a throttled parameter that is not a string");
}

// Object#presence for a parameter: a blank string, array or hash is not a token. Any other value would be interpolated by Ruby's `to_s`.
function presentToken(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  const empty = Array.isArray(value) ? value.length === 0 : isHash(value) && Object.keys(value).length === 0;
  if (empty) return null;
  throw new HandBackToRails("an access_token that is not a string");
}

// v2_product_token in rack_attack.rb: `params["access_token"].presence`, else the bearer token of the Authorization header.
function v2Token(request: RackRequest): string | null {
  return (
    presentToken(rackParams(request).access_token) ?? /^bearer\s+(\S+)/iu.exec(request.authorization ?? "")?.[1] ?? null
  );
}

// `page.is_a?(Integer) || page.is_a?(String) ? page.to_i : 0`; a form or query value is never an Integer.
function pageNumber(page: unknown): number {
  if (typeof page !== "string") return 0;
  const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(page);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
}

async function passwordResetRecipient(request: RackRequest): Promise<string> {
  if (request.invalidParams) throw new RackParamsInvalid();
  const body = request.mediaType?.includes("json") ? request.json : request.form;
  const params = isHash(body) ? { ...body, ...request.query } : request.query;
  const userParams = params.user;
  const email = isHash(userParams) && typeof userParams.email === "string" ? userParams.email : null;
  const user =
    email !== null && isValidEmailFormat(email)
      ? await db.user.findFirst({ where: { email, deleted_at: null }, orderBy: { id: "asc" }, select: { id: true } })
      : null;
  const address = email === null ? "" : email.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r \0]+$/gu, "").toLowerCase();
  if (user !== null) return `user:${user.id}`;
  return address === "" ? request.remoteIp : `email:${address}`;
}

// throttle_by_ip with a regexp path keys on "path:ip"; with a string path, on the ip.
const ipRule =
  (path: RegExp, method: string): Throttle["discriminator"] =>
  (request) =>
    request.method === method && path.test(request.path) ? `${request.path}:${request.remoteIp}` : null;

// throttle_by_ip on a string path: the identifier is the address alone.
const exactPathIp =
  (path: string): Throttle["discriminator"] =>
  (request) =>
    request.path === path ? request.remoteIp : null;

// throttle_by_params on a path regexp: the identifier carries the path and the OAuth token.
const tokenRule =
  (path: RegExp, method: string): Throttle["discriminator"] =>
  (request) =>
    request.method === method && path.test(request.path) ? `${request.path}:${v2Token(request) ?? ""}` : null;

const MOBILE_DOWNLOAD_PATH = /^\/(?:api\/)?mobile\/url_redirects\/download\/(?<token>[^/]+)\/(?<file>[^/.]+)/u;
const MCP_REGISTRATION_PATH = /^\/(?:muse|claude|chatgpt|cursor|antigravity)\/v1\/oauth2\/register(?:\.[^/]+)?$/u;
const USER_CUSTOM_HTML_PATH = /^\/(api\/)?v2\/user\/custom_html(\.\w+)?$/u;
const USER_PREVIEW_PATH = /^\/(api\/)?v2\/user\/preview_custom_html(\.\w+)?$/u;
const PRODUCTS_PATH = /^\/(api\/)?v2\/products(\.\w+)?$/u;
const PRODUCTS_COMPS_PATH = /^\/(api\/)?v2\/products\/comps(\.\w+)?$/u;
const PRODUCT_PREVIEW_PATH = /^\/(api\/)?v2\/products\/[^/]+\/preview_custom_html(\.\w+)?$/u;
const MEDIA_PATH = /^\/(api\/)?v2\/media(\.\w+)?$/u;
const PRODUCT_WRITE_PATH = /^\/(api\/)?v2\/products\/[^/]+(\.\w+)?$/u;
const AFFILIATE_REQUESTS_PATH = /^\/[\p{L}\p{N}]+\/affiliate_requests$/u;
const ACME_CHALLENGE_PREFIX = "/.well-known/acme-challenge/";
const HELP_CONTACT_PATH = /^\/help\/contact(?:\.[^/]+)?$/u;
const OAUTH_DEVICE_CODE_PATH = /^\/oauth\/device\/code(?:\.[^/]+)?$/u;
const OAUTH_DEVICE_PATH = /^\/oauth\/device(?:\.[^/]+)?$/u;
const OAUTH_TOKEN_PATH = /^\/oauth\/token(?:\.[^/]+)?$/u;
const OAUTH_TOKEN_ALIASES_PATH =
  /^(?:\/oauth\/token|\/(?:muse|claude|chatgpt|cursor|antigravity)\/v1\/oauth2\/token)(?:\.[^/]+)?$/u;
const PASSKEY_REGISTRATION_OPTIONS_PATH = /^\/settings\/passkeys\/registration_options(?:\.[^/]+)?$/u;
const PASSKEYS_PATH = /^\/settings\/passkeys(?:\.[^/]+)?$/u;
const MARKETING_EXECUTE_PATH = /^\/products\/[^/]+\/marketing_actions\/[^/]+\/execute(?:\.[^/]+)?$/u;
const PASSKEY_LOGIN_OPTIONS_PATH = /^\/login\/passkey\/options(?:\.[^/]+)?$/u;
const PASSKEY_LOGIN_PATH = /^\/login\/passkey(?:\.[^/]+)?$/u;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const VIP_GROSS_PAID_PAYOUTS_THRESHOLD_CENTS = 500_000;

// Ruby's Regexp#to_s of those path regexps, which names the rules `throttle_by_ip` and `throttle_by_params` register.
const RUBY_PATH = {
  userCustomHtml: "(?-mix:\\A\\/(api\\/)?v2\\/user\\/custom_html(\\.\\w+)?\\z)",
  userPreview: "(?-mix:\\A\\/(api\\/)?v2\\/user\\/preview_custom_html(\\.\\w+)?\\z)",
  products: "(?-mix:\\A\\/(api\\/)?v2\\/products(\\.\\w+)?\\z)",
  productsComps: "(?-mix:\\A\\/(api\\/)?v2\\/products\\/comps(\\.\\w+)?\\z)",
  productPreview: "(?-mix:\\A\\/(api\\/)?v2\\/products\\/[^\\/]+\\/preview_custom_html(\\.\\w+)?\\z)",
  media: "(?-mix:\\A\\/(api\\/)?v2\\/media(\\.\\w+)?\\z)",
  productWrite: "(?-mix:\\A\\/(api\\/)?v2\\/products\\/[^\\/]+(\\.\\w+)?\\z)",
  affiliateRequests: "(?-mix:\\A\\/[[:alnum:]]+\\/affiliate_requests\\z)",
  acmeChallenge: "(?-mix:\\A\\/\\.well-known\\/acme-challenge\\/)",
} as const;

const API_V2_TOKEN_MAX_LEVEL = 6;

// GROUPED_RECEIPT_LOOKUP_PATHS: each path with an optional format suffix.
const GROUPED_RECEIPT_PATHS = ["/charge_data", "/license_key_lookup_data", "/paypal_charge_data"] as const;
const groupedReceiptPath = (path: string, requestPath: string) =>
  requestPath === path || (requestPath.startsWith(`${path}.`) && !requestPath.slice(path.length + 1).includes("/"));

// `req.params["email"].to_s.strip.downcase.presence`, shared by the first two lookups: the harm is to the recipient, so it is keyed apart from the address.
function groupedReceiptRecipient(request: RackRequest): string | null {
  if (
    !groupedReceiptPath("/charge_data", request.path) &&
    !groupedReceiptPath("/license_key_lookup_data", request.path)
  )
    return null;
  const email = interpolate(rackParams(request).email)
    .replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "")
    .toLowerCase();
  return email === "" ? null : email;
}

// Listed in the order rack_attack.rb defines them, which is the order Rack::Attack counts in.
// The `user[login]` that `throttle("logins/login")` keys on. Ruby's `String#[]` and `Array#[]` answer something else for a `user` that is not a
// hash, and a non-string login interpolates differently.
function loginParam(request: RackRequest): string | null {
  if (request.path !== "/login.json" || request.method !== "POST") return null;
  const user = rackParams(request).user;
  if (user === undefined || user === null) return null;
  if (!isHash(user)) throw new HandBackToRails("a login throttle parameter that is not a hash");
  const login = user.login;
  if (login === undefined || login === null) return null;
  if (typeof login !== "string") throw new HandBackToRails("a login throttle parameter that is not a string");
  // `.presence`: a blank string is no key.
  return /^[\t\n\v\f\r ]*$/u.test(login) ? null : login;
}

// Rack::Attack.vip_token?, without the 10 minute Rails.cache entry: a creator who crosses the payout threshold counts as a VIP here up to
// that long before Rails' cached answer flips (parity-debt.md).
async function vipToken(token: string | null): Promise<boolean> {
  if (token === null || token.trim() === "") return false;
  const access = await db.oauthAccessToken.findFirst({ where: { token } });
  if (access?.resource_owner_id == null) return false;
  const now = Date.now();
  const expired = access.expires_in !== null && now > access.created_at.getTime() + access.expires_in * 1000;
  const revoked = access.revoked_at !== null && access.revoked_at.getTime() <= now;
  if (expired || revoked) return false;
  const owner = await db.user.findUnique({ where: { id: BigInt(access.resource_owner_id) }, select: { id: true } });
  if (owner === null) return false;
  const paid = await db.payment.aggregate({
    _sum: { amount_cents: true },
    where: { user_id: owner.id, state: "completed" },
  });
  return Number(paid._sum.amount_cents ?? 0) > VIP_GROSS_PAID_PAYOUTS_THRESHOLD_CENTS;
}

// `vip_product_writer`, memoized per request as `req.memoize(:vip_product_writer)` is.
const vipWriters = new WeakMap<RackRequest, Promise<boolean>>();
function vipProductWriter(request: RackRequest): Promise<boolean> {
  if (!vipWriters.has(request)) vipWriters.set(request, vipToken(v2Token(request)));
  return vipWriters.get(request)!;
}

// throttle_by_ip and throttle_by_params with `only_if:` on the product write path: the VIP lookup runs only once the path and verb match.
const productWriteIp =
  (method: string, vip: boolean): Throttle["discriminator"] =>
  async (request) =>
    request.method === method && PRODUCT_WRITE_PATH.test(request.path) && (await vipProductWriter(request)) === vip
      ? `${request.path}:${request.remoteIp}`
      : null;
const productWriteToken =
  (method: string, vip: boolean): Throttle["discriminator"] =>
  async (request) =>
    request.method === method && PRODUCT_WRITE_PATH.test(request.path) && (await vipProductWriter(request)) === vip
      ? `${request.path}:${v2Token(request) ?? ""}`
      : null;

// throttle_by_ip on a string path with an optional verb: the identifier is the address alone.
const stringPathIp =
  (path: string, method: string | null): Throttle["discriminator"] =>
  (request) =>
    request.path === path && (method === null || request.method === method) ? request.remoteIp : null;

// A path regexp with its verbs, keyed on the address alone (`req.remote_ip if req.path.match?(...) && req.post?`).
const regexpIp =
  (path: RegExp, methods: readonly string[]): Throttle["discriminator"] =>
  (request) =>
    path.test(request.path) && methods.includes(request.method) ? request.remoteIp : null;

// `req.env["warden"]&.user&.id if <path> && req.post?`: no signed-in user is no bucket.
const wardenRule =
  (path: RegExp): Throttle["discriminator"] =>
  (request) =>
    path.test(request.path) && request.method === "POST" ? request.wardenUserId() : null;

// oauth_device_token/ip/device_code: the address and the SHA256 of the submitted device code, for the device-code grant on POST /oauth/token.
function deviceCodeBucket(request: RackRequest): string | null {
  if (!OAUTH_TOKEN_PATH.test(request.path) || request.method !== "POST") return null;
  if (request.invalidParams) throw new RackParamsInvalid();
  const body = request.mediaType?.includes("json") ? request.json : request.form;
  const params = isHash(body) ? { ...body, ...request.query } : request.query;
  if (params.grant_type !== DEVICE_CODE_GRANT) return null;
  return `${request.remoteIp}:${createHash("sha256").update(interpolate(params.device_code)).digest("hex")}`;
}

const PRODUCTION_PATH_RULES = [
  ["/ip:/login:post", "/login", "POST"],
  ["/ip:/login.json", "/login.json", null],
  ["/ip:/signup", "/signup", null],
  ["/ip:/signup.json", "/signup.json", null],
] as const;

const RULES: Throttle[] = [
  // 5 per minute, with tiers to 7: a request whose params Rack cannot parse.
  ...backoff(
    "invalid_params",
    5,
    60,
    7,
    memoized((request) => (request.invalidParams ? `${request.path}:${request.remoteIp}` : null)),
  ),
  ...productionOnly(
    PRODUCTION_PATH_RULES.flatMap(([name, path, method]) =>
      backoff(
        name,
        3,
        20,
        5,
        memoized((request) =>
          request.path === path && (method === null || request.method === method) ? request.remoteIp : null,
        ),
      ),
    ),
  ),
  ...productionOnly(
    backoff(
      "/ip:/follow:post",
      3,
      20,
      5,
      memoized((request) => (request.method === "POST" && request.path === "/follow" ? request.remoteIp : null)),
    ),
  ),
  ...productionOnly(backoff("/ip:/follow_from_embed_form", 3, 20, 5, memoized(exactPathIp("/follow_from_embed_form")))),
  ...productionOnly(backoff("/ip:/users/auth/facebook", 3, 20, 5, memoized(exactPathIp("/users/auth/facebook")))),
  ...productionOnly(
    backoff(
      "/ip:/settings:put",
      3,
      20,
      5,
      memoized((request) => (request.method === "PUT" && request.path === "/settings" ? request.remoteIp : null)),
    ),
  ),
  ...productionOnly(
    ["/sellers/brand_accounts", "/sellers/brand_accounts.json"].flatMap((path) =>
      backoff(`/ip:${path}:post`, 3, 20, 5, memoized(stringPathIp(path, "POST"))),
    ),
  ),
  ...backoff("/ip:/", 60, 30, 5, memoized(exactPathIp("/"))),
  ...["/api/mobile/purchases/index.json", "/mobile/purchases/index.json"].flatMap((path) =>
    backoff(`/ip:${path}`, 60, 30, 5, memoized(exactPathIp(path))),
  ),
  ...backoff("/ip:/discover", 60, 30, 5, memoized(exactPathIp("/discover"))),
  ...backoff("/ip:/discover_search", 60, 30, 5, memoized(exactPathIp("/discover_search"))),
  ...backoff("/ip:/offer_codes/compute_discount", 60, 30, 5, memoized(exactPathIp("/offer_codes/compute_discount"))),
  ...["/purchases", "/stripe/setup_intents"].flatMap((path) =>
    backoff(`/ip:${path}`, 40, 60, 5, memoized(exactPathIp(path))),
  ),
  ...backoff("/ip:/settings/credit_card", 3, 20, 5, memoized(exactPathIp("/settings/credit_card"))),
  ...backoff(
    "mobile_url_redirect_download/token",
    60,
    60,
    1,
    memoized((request) => {
      if (request.method !== "GET" && request.method !== "HEAD") return null;
      const match = MOBILE_DOWNLOAD_PATH.exec(request.path)?.groups;
      return match ? `${match.token}/${match.file}` : null;
    }),
  ),
  // throttle_by_ip_for_period: one counter, no tiers.
  { name: "/ip/period:/purchases", limit: 50, period: 3600, discriminator: exactPathIp("/purchases") },
  ...backoff("help_center_contact/ip", 3, 60, 1, memoized(regexpIp(HELP_CONTACT_PATH, ["POST"]))),
  ...GROUPED_RECEIPT_PATHS.flatMap((path) =>
    backoff(
      `/ip:${path}`,
      3,
      20,
      5,
      memoized((request) => (groupedReceiptPath(path, request.path) ? request.remoteIp : null)),
    ),
  ),
  ...backoff("/params:grouped_receipt:email", 6, 60, 6, memoized(groupedReceiptRecipient)),
  ...backoff("oauth_device_code/ip", 20, 60, 5, memoized(regexpIp(OAUTH_DEVICE_CODE_PATH, ["POST"]))),
  ...backoff("oauth_device_authorization_lookup/ip", 30, 60, 5, memoized(regexpIp(OAUTH_DEVICE_PATH, ["GET", "HEAD"]))),
  ...backoff("oauth_device_authorization_decision/ip", 10, 60, 5, memoized(regexpIp(OAUTH_DEVICE_PATH, ["POST"]))),
  ...backoff(
    "oauth_token/ip",
    3000,
    60,
    5,
    memoized((request) => (OAUTH_TOKEN_ALIASES_PATH.test(request.path) ? request.remoteIp : null)),
  ),
  ...backoff(
    "oauth_dynamic_registration/ip",
    20,
    60,
    5,
    memoized((request) =>
      MCP_REGISTRATION_PATH.test(request.path) && request.method === "POST" ? request.remoteIp : null,
    ),
  ),
  { name: "oauth_device_token/ip/device_code", limit: 120, period: 60, discriminator: deviceCodeBucket },
  ...backoff(
    "/ip/params:/follow:post",
    3,
    60,
    6,
    memoized((request) =>
      request.method === "POST" && request.path === "/follow"
        ? `${request.remoteIp}:${interpolate(rackParams(request).seller_id)}`
        : null,
    ),
  ),
  ...backoff(
    "/ip/params:/follow_from_embed_form",
    3,
    60,
    6,
    memoized((request) =>
      request.path === "/follow_from_embed_form"
        ? `${request.remoteIp}:${interpolate(rackParams(request).seller_id)}`
        : null,
    ),
  ),
  ...backoff(
    "/ip/params:(?-mix:\\A\\/(?:[^\\/]+\\/)?landing\\/products\\z):get",
    30,
    60,
    6,
    memoized((request) =>
      request.method === "GET" && LANDING_PRODUCTS_PATH.test(request.path)
        ? `${request.path}:${request.remoteIp}:${request.host}`
        : null,
    ),
  ),
  ...backoff(
    "products_search/ip",
    300,
    60,
    5,
    memoized((request) =>
      (request.method === "GET" || request.method === "HEAD") && PRODUCTS_SEARCH_PATH.test(request.path)
        ? request.remoteIp
        : null,
    ),
  ),
  ...TWO_FACTOR_BY_USER.flatMap(([path, method]) =>
    backoff(
      `/params:${path}${method === null ? "" : ":post"}`,
      10,
      60,
      6,
      memoized((request) =>
        request.path === path && (method === null || request.method === method)
          ? interpolate(rackParams(request).user_id)
          : null,
      ),
    ),
  ),
  // throttle_by_params: a signed-out request is counted under the empty identifier.
  ...backoff(
    "/params:/settings/totp/confirm:post",
    10,
    60,
    6,
    memoized(async (request) =>
      request.path === "/settings/totp/confirm" && request.method === "POST"
        ? ((await request.wardenUserId()) ?? "")
        : null,
    ),
  ),
  ...backoff(
    "/params:/settings/passkeys/registration_options:POST",
    10,
    60,
    6,
    memoized(wardenRule(PASSKEY_REGISTRATION_OPTIONS_PATH)),
  ),
  ...backoff("/params:/settings/passkeys:POST", 10, 60, 6, memoized(wardenRule(PASSKEYS_PATH))),
  ...backoff(
    "/params:/products/:id/marketing_actions/:id/execute:POST",
    5,
    60,
    6,
    memoized(wardenRule(MARKETING_EXECUTE_PATH)),
  ),
  ...backoff("/ip:/login/passkey/options:POST", 10, 60, 6, memoized(regexpIp(PASSKEY_LOGIN_OPTIONS_PATH, ["POST"]))),
  ...backoff("/ip:/login/passkey:POST", 10, 60, 6, memoized(regexpIp(PASSKEY_LOGIN_PATH, ["POST"]))),
  ...backoff(
    "password_reset/ip",
    3,
    20,
    5,
    memoized((request) =>
      PASSWORD_RESET_PATH.test(request.path) && request.method === "POST" ? request.remoteIp : null,
    ),
  ),
  ...backoff(
    "password_reset/email",
    4,
    60,
    6,
    memoized((request) =>
      PASSWORD_RESET_PATH.test(request.path) && request.method === "POST" ? passwordResetRecipient(request) : null,
    ),
  ),
  // A plain `throttle`: ten requests per second past page ten of the sales index.
  {
    name: "/api/v2/sales",
    limit: 10,
    period: 1,
    discriminator: (request) =>
      request.path.endsWith("/v2/sales") && pageNumber(rackParams(request).page) > 10 ? request.remoteIp : null,
  },
  // A plain `throttle`, no tiers: it stops a botnet rotating addresses against one account.
  { name: "logins/login", limit: 3, period: 20, discriminator: loginParam },
  ...backoff(`/ip:${RUBY_PATH.affiliateRequests}:post`, 10, 60, 5, memoized(ipRule(AFFILIATE_REQUESTS_PATH, "POST"))),
  ...backoff("/ip:(?-mix:\\A\\/posts\\/.+\\/comments\\z):post", 5, 60, 5, memoized(ipRule(COMMENTS_PATH, "POST"))),
  ...backoff("/ip:(?-mix:\\A\\/posts\\/.+\\/comments\\/.+\\z):put", 5, 60, 5, memoized(ipRule(COMMENT_PATH, "PUT"))),
  // Keyed on the path without its format suffix, so `/resend_receipt.json` shares the bucket.
  ...backoff(
    "/ip:resend_receipt",
    2,
    60,
    5,
    memoized((request) => {
      const match = RESEND_RECEIPT_PATH.exec(request.path);
      return match !== null && request.method === "POST" ? `${match[1]!}:${request.remoteIp}` : null;
    }),
  ),
  // throttle_by_ip_for_period: one counter, no tiers.
  {
    name: "/ip/period:(?-mix:\\A\\/communities\\/[^\\/]+\\/chat_messages\\z):post",
    limit: 60,
    period: 60,
    discriminator: ipRule(CHAT_MESSAGES_PATH, "POST"),
  },
  {
    name: "/ip/period:/internal/ai_product_details_generations:post",
    limit: 10,
    period: 60,
    discriminator: stringPathIp("/internal/ai_product_details_generations", "POST"),
  },
  {
    name: `/ip/period:${RUBY_PATH.acmeChallenge}`,
    limit: 120,
    period: 60,
    discriminator: (request) =>
      request.path.startsWith(ACME_CHALLENGE_PREFIX) ? `${request.path}:${request.remoteIp}` : null,
  },
  ...backoff(`/ip:${RUBY_PATH.products}:post`, 10, 60, 5, memoized(ipRule(PRODUCTS_PATH, "POST"))),
  ...backoff(`/ip:${RUBY_PATH.productsComps}:get`, 30, 60, 5, memoized(ipRule(PRODUCTS_COMPS_PATH, "GET"))),
  ...["put", "patch"].flatMap((verb) => [
    ...backoff(`/ip:${RUBY_PATH.productWrite}:${verb}`, 30, 60, 5, memoized(productWriteIp(verb.toUpperCase(), false))),
    ...backoff(
      `/params:${RUBY_PATH.productWrite}:${verb}`,
      30,
      60,
      API_V2_TOKEN_MAX_LEVEL,
      memoized(productWriteToken(verb.toUpperCase(), false)),
    ),
    ...backoff(
      `/vip/ip:${RUBY_PATH.productWrite}:${verb}`,
      150,
      60,
      5,
      memoized(productWriteIp(verb.toUpperCase(), true)),
    ),
    ...backoff(
      `/vip/params:${RUBY_PATH.productWrite}:${verb}`,
      150,
      60,
      API_V2_TOKEN_MAX_LEVEL,
      memoized(productWriteToken(verb.toUpperCase(), true)),
    ),
  ]),
  ...backoff(
    `/params:${RUBY_PATH.productsComps}:get`,
    30,
    60,
    API_V2_TOKEN_MAX_LEVEL,
    memoized(tokenRule(PRODUCTS_COMPS_PATH, "GET")),
  ),
  ...backoff(`/ip:${RUBY_PATH.productPreview}:post`, 60, 60, 5, memoized(ipRule(PRODUCT_PREVIEW_PATH, "POST"))),
  ...backoff(
    `/params:${RUBY_PATH.productPreview}:post`,
    60,
    60,
    API_V2_TOKEN_MAX_LEVEL,
    memoized(tokenRule(PRODUCT_PREVIEW_PATH, "POST")),
  ),
  ...backoff(`/ip:${RUBY_PATH.userCustomHtml}:put`, 30, 60, 5, memoized(ipRule(USER_CUSTOM_HTML_PATH, "PUT"))),
  ...backoff(`/ip:${RUBY_PATH.userCustomHtml}:patch`, 30, 60, 5, memoized(ipRule(USER_CUSTOM_HTML_PATH, "PATCH"))),
  ...backoff(
    `/params:${RUBY_PATH.userCustomHtml}:put`,
    30,
    60,
    API_V2_TOKEN_MAX_LEVEL,
    memoized(tokenRule(USER_CUSTOM_HTML_PATH, "PUT")),
  ),
  ...backoff(
    `/params:${RUBY_PATH.userCustomHtml}:patch`,
    30,
    60,
    API_V2_TOKEN_MAX_LEVEL,
    memoized(tokenRule(USER_CUSTOM_HTML_PATH, "PATCH")),
  ),
  ...backoff(`/ip:${RUBY_PATH.userPreview}:post`, 60, 60, 5, memoized(ipRule(USER_PREVIEW_PATH, "POST"))),
  ...backoff(
    `/params:${RUBY_PATH.userPreview}:post`,
    60,
    60,
    API_V2_TOKEN_MAX_LEVEL,
    memoized(tokenRule(USER_PREVIEW_PATH, "POST")),
  ),
  ...backoff(`/ip:${RUBY_PATH.media}:post`, 20, 600, 1, memoized(ipRule(MEDIA_PATH, "POST"))),
  ...backoff(
    "media_uploads/token",
    20,
    600,
    1,
    memoized((request) => (MEDIA_PATH.test(request.path) && request.method === "POST" ? v2Token(request) : null)),
  ),
];

// The rules of RULES by name, for the guard test.
export const RACK_ATTACK_RULES: readonly Throttle[] = RULES;
export const RACK_ATTACK_RULE_NAMES: readonly string[] = RULES.map((rule) => rule.name);

// The rules a request is counted in: the production-only ones count outside production when the replay of a recording made with them asks.
function activeRules(): readonly Throttle[] {
  return productionRulesOn() ? RULES : RULES.filter((rule) => rule.productionOnly !== true);
}

const counted = new WeakMap<Request, string[]>();

function jsonBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return {};
  }
}

// ActionDispatch::Journey::Router::Utils.normalize_path, which Rack::Attack runs on PATH_INFO: a leading slash, runs of slashes squeezed,
// the trailing slash dropped and percent escapes upcased.
export function normalizePath(path: string): string {
  const squeezed = `/${path}`.replace(/\/+/gu, "/").replace(/\/+$/u, "");
  return (squeezed === "" ? "/" : squeezed).replace(/(%[a-f0-9]{2})/gu, (escape) => escape.toUpperCase());
}

// Rack::Attack.throttle_discriminator_normalizer: `discriminator.to_s.strip.downcase`.
const normalizeDiscriminator = (discriminator: string) =>
  discriminator.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "").toLowerCase();

// ActionDispatch::RemoteIp skips these trusted proxies when it walks X-Forwarded-For from the right.
const PRIVATE_ADDRESS = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)/u;

// Rack::QueryParser raises InvalidParameterError for a `%` that does not start a hex escape (invalid UTF-8 is left alone), and QueryLimitError
// past PARAMS_LIMIT pairs or PARAM_DEPTH_LIMIT nested brackets. `req.params` then raises, which the `invalid_params` rule counts.
const PARAMS_LIMIT = 4096;
const PARAM_DEPTH_LIMIT = 32;
const BAD_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/u;
function unparseable(encoded: string): boolean {
  const pairs = encoded.split("&").filter((pair) => pair !== "");
  if (pairs.length > PARAMS_LIMIT) return true;
  return pairs.some((pair) => {
    if (BAD_PERCENT_ESCAPE.test(pair)) return true;
    const key = pair.split("=", 1)[0]!;
    return key.replace(/%5B/giu, "[").split("[").length - 1 >= PARAM_DEPTH_LIMIT;
  });
}

export function rackRequest(request: Request, bytes: Uint8Array): RackRequest {
  const rails: RailsRequest = railsRequest(request);
  const contentType = request.headers.get("content-type");
  const mediaType = contentType === null ? null : contentType.split(";")[0]!.trim().toLowerCase();
  const isForm = mediaType === "application/x-www-form-urlencoded";
  const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim());
  const invalidParams = unparseable(rails.queryString) || (isForm && unparseable(Buffer.from(bytes).toString("utf8")));
  let wardenUser: Promise<string | null> | undefined;
  return {
    method: rails.method,
    path: normalizePath(rails.path),
    host: rails.host,
    // Rack::Attack::Request#remote_ip: Cloudflare's header, else ActionDispatch's address.
    remoteIp:
      request.headers.get("cf-connecting-ip") ??
      [...forwarded].reverse().find((entry) => entry !== "" && !PRIVATE_ADDRESS.test(entry)) ??
      forwarded.find((entry) => entry !== "") ??
      "",
    query: invalidParams ? {} : parseNestedQuery(rails.queryString),
    form: isForm && !invalidParams ? parseBody(contentType, bytes) : {},
    json: mediaType?.includes("json") ? jsonBody(bytes) : {},
    mediaType,
    authorization: request.headers.get("authorization"),
    invalidParams,
    // A remember-me cookie signs a user in only inside the controller, after Rack::Attack has run, so it is no Warden user here.
    wardenUserId: () =>
      (wardenUser ??= resolveRequestAuth(rails, new Date()).then((auth) => {
        if (auth.authenticatedVia === "remember_cookie") return null;
        const user = auth.context.loggedInUser ?? auth.effects.signedOut?.user ?? null;
        return user === null ? null : String(user.id);
      })),
  };
}

export async function evaluate(
  request: RackRequest,
  store: RackStore = redisStore,
  rules: readonly Throttle[] = activeRules(),
  now: () => number = () => Math.floor(Date.now() / 1000),
  // Filled as rules are counted, so a rule that throws still leaves the earlier counts to be taken back.
  keys: string[] = [],
): Promise<Throttled | null> {
  if (LOCALHOST_ADDRESSES.has(request.remoteIp)) return null;
  for (const rule of rules) {
    let raw: string | null;
    try {
      raw = await rule.discriminator(request);
    } catch (error) {
      // The rescue of throttle_with_exponential_backoff: a rule that cannot read the params skips the request.
      if (error instanceof RackParamsInvalid) continue;
      throw error;
    }
    if (raw === null) continue;
    // Without a client address the rules cannot key the request the way Rails does.
    if (request.remoteIp === "") throw new HandBackToRails("a request with no client address");
    const discriminator = normalizeDiscriminator(raw);
    const epochTime = now();
    // Add 1 to expires_in to avoid timing error (rack-attack#85), as Rack::Attack::Cache does.
    const expiresIn = rule.period - (epochTime % rule.period) + 1;
    const key = `${KEY_PREFIX}:${Math.floor(epochTime / rule.period)}:${rule.name}:${discriminator}`;
    const count = await store.increment(key, expiresIn);
    keys.push(key);
    if (count > rule.limit) return { name: rule.name, period: rule.period, epochTime };
  }
  return null;
}

// Only a form or JSON body is read by the rules; other bodies (uploads) are left alone.
async function bodyBytes(request: Request): Promise<Uint8Array> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) return new Uint8Array();
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded|json/iu.test(contentType)) return new Uint8Array();
  return new Uint8Array(await request.clone().arrayBuffer());
}

// Counts `request` and answers the 429 of Rack::Attack's default responder when a rule is over its limit.
export async function countRackAttack(request: Request): Promise<Response | null> {
  const keys: string[] = [];
  counted.set(request, keys);
  const rack = rackRequest(request, await bodyBytes(request));
  const throttled = await evaluate(rack, redisStore, activeRules(), undefined, keys);
  if (throttled === null) return null;
  const retryAfter = throttled.period - (throttled.epochTime % throttled.period);
  return rackResponse(
    request,
    TOO_MANY_REQUESTS,
    { "content-type": "text/plain", "retry-after": String(retryAfter) },
    "Retry later\n",
  );
}

// A request Node hands back is counted by Rails' middleware, so Node takes its own count back.
export async function uncountRackAttack(request: Request, store: RackStore = redisStore): Promise<void> {
  const keys = counted.get(request);
  if (keys === undefined) return;
  counted.delete(request);
  await Promise.all(keys.map((key) => store.decrement(key)));
}
