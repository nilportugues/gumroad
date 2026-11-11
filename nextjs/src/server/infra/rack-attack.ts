// The Rack::Attack throttles of config/initializers/rack_attack.rb that cover a route Node answers. Rack::Attack counts in Rails' Redis
// before any controller runs, so a Node answer has to count there as well, under the same key, expiry and limit. Only the rules named
// in RULES are modelled; src/server/controllers/rack-attack-throttles.test.ts keeps routes.json from serving any other throttled path.
//
// Counting happens ahead of the action. A request Node then hands back to Rails would be counted twice (Rails counts it again), so the
// caller undoes this module's increments before it forwards.
import type { Redis } from "ioredis";

import { getRedis } from "./redis.ts";
import { secureHeaders } from "./secure-headers.ts";

const KEY_PREFIX = "rack::attack";
const LOCALHOST = new Set(["127.0.0.1", "::1"]);
const PRIVATE_ADDRESS = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)/u;
const DEFAULT_MAX_LEVEL = 5;
const PARAMS_MAX_LEVEL = 6;
const BACKOFF_BASE = 8;
const SECONDS_PER_MINUTE = 60;

export type ThrottleRequest = {
  method: string;
  path: string;
  headers: Headers;
  // Rack's `req.params` (query string merged with a form body): only read by a rule that needs it.
  params(): Promise<Record<string, unknown>>;
};

type Discriminator = (request: ThrottleRequest, ip: string) => string | null | undefined | false | Promise<string | null | undefined | false>;

export type Throttle = { name: string; limit: number; period: number; discriminator: Discriminator };

export type ThrottleRule = {
  // The path literal as rack_attack.rb writes it (checked against the file by rack-attack-throttles.test.ts).
  source: string;
  throttles: Throttle[];
};

// Rack::Attack::Request#remote_ip: CF-Connecting-IP, then ActionDispatch::RemoteIp (the rightmost X-Forwarded-For entry that is not a
// private address), then the socket address, which a request Node receives behind the proxy does not carry.
export function rackRemoteIp(headers: Headers): string {
  const cloudflare = headers.get("cf-connecting-ip");
  if (cloudflare !== null && cloudflare !== "") return cloudflare;
  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return [...forwarded].reverse().find((address) => !PRIVATE_ADDRESS.test(address)) ?? forwarded[0] ?? "127.0.0.1";
}

// `throttle_with_exponential_backoff`: the base throttle and, for each level up to max_level, one that allows `rpm * level` requests
// per 8^level seconds.
export function exponentialBackoff(
  name: string,
  requests: number,
  period: number,
  discriminator: Discriminator,
  maxLevel = DEFAULT_MAX_LEVEL,
): Throttle[] {
  const rpm = (requests / period) * SECONDS_PER_MINUTE;
  const levels = Array.from({ length: Math.max(maxLevel - 1, 0) }, (_, index) => index + 2);
  return [
    { name, limit: requests, period, discriminator },
    ...levels.map((level) => ({ name: `${name}/${level}`, limit: rpm * level, period: BACKOFF_BASE ** level, discriminator })),
  ];
}

// Object#presence for a string; any other value is not a token.
const presence = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

// v2_product_token in rack_attack.rb: `params["access_token"].presence`, else the bearer token of the Authorization header.
export async function bearerOrAccessToken(request: ThrottleRequest): Promise<string | undefined> {
  const fromParams = presence((await request.params()).access_token);
  if (fromParams !== undefined) return fromParams;
  return /^bearer\s+(\S+)/iu.exec(request.headers.get("authorization") ?? "")?.[1];
}

// `req.params["page"]` read as `page.is_a?(Integer) || page.is_a?(String) ? page.to_i : 0`.
const pageNumber = (page: unknown): number => {
  if (typeof page === "number") return Math.trunc(page);
  if (typeof page !== "string") return 0;
  const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(page);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
};

const matches = (request: ThrottleRequest, pattern: RegExp, method?: string) =>
  pattern.test(request.path) && (method === undefined || request.method === method);

const MCP_REGISTRATION_PATH = /^\/(?:muse|claude|chatgpt)\/v1\/oauth2\/register(?:\.[^/]+)?$/u;
const MOBILE_DOWNLOAD_PATH = /^\/(?:api\/)?mobile\/url_redirects\/download\/(?<token>[^/]+)\/(?<file>[^/.]+)/u;
const USER_CUSTOM_HTML_PATH = /^\/(api\/)?v2\/user\/custom_html(\.\w+)?$/u;
const USER_PREVIEW_PATH = /^\/(api\/)?v2\/user\/preview_custom_html(\.\w+)?$/u;
const PRODUCTS_PATH = /^\/(api\/)?v2\/products(\.\w+)?$/u;
const PRODUCTS_COMPS_PATH = /^\/(api\/)?v2\/products\/comps(\.\w+)?$/u;
const PRODUCT_PREVIEW_PATH = /^\/(api\/)?v2\/products\/[^/]+\/preview_custom_html(\.\w+)?$/u;
const MEDIA_PATH = /^\/(api\/)?v2\/media(\.\w+)?$/u;

// Ruby's Regexp#to_s of the path regexps, which is what names a `throttle_by_ip` and `throttle_by_params` rule.
const RUBY_REGEXP_NAMES = {
  userCustomHtml: "(?-mix:\\A\\/(api\\/)?v2\\/user\\/custom_html(\\.\\w+)?\\z)",
  userPreview: "(?-mix:\\A\\/(api\\/)?v2\\/user\\/preview_custom_html(\\.\\w+)?\\z)",
  products: "(?-mix:\\A\\/(api\\/)?v2\\/products(\\.\\w+)?\\z)",
  productsComps: "(?-mix:\\A\\/(api\\/)?v2\\/products\\/comps(\\.\\w+)?\\z)",
  productPreview: "(?-mix:\\A\\/(api\\/)?v2\\/products\\/[^\\/]+\\/preview_custom_html(\\.\\w+)?\\z)",
  media: "(?-mix:\\A\\/(api\\/)?v2\\/media(\\.\\w+)?\\z)",
} as const;

// `throttle_by_ip` on a path regexp: the identifier carries the request path as well.
function byIpOnRegexp(name: string, pattern: RegExp, method: string, requests: number, period: number, maxLevel?: number): Throttle[] {
  return exponentialBackoff(
    name,
    requests,
    period,
    (request, ip) => (matches(request, pattern, method) ? `${request.path}:${ip}` : undefined),
    maxLevel,
  );
}

// `throttle_by_params` on a path regexp, keyed by the OAuth token.
function byTokenOnRegexp(name: string, pattern: RegExp, method: string, requests: number, period: number): Throttle[] {
  return exponentialBackoff(
    name,
    requests,
    period,
    async (request) => (matches(request, pattern, method) ? `${request.path}:${(await bearerOrAccessToken(request)) ?? ""}` : undefined),
    PARAMS_MAX_LEVEL,
  );
}

// In the order rack_attack.rb defines them: Rack::Attack stops at the first throttle that trips, so an earlier tier counts a request a later
// one never sees.
export const RULES: ThrottleRule[] = [
  {
    source: "/discover",
    throttles: exponentialBackoff("/ip:/discover", 60, 30, (request, ip) => (request.path === "/discover" ? ip : undefined)),
  },
  {
    source: "\\A/(?:api/)?mobile/url_redirects/download/(?<token>[^/]+)/(?<file>[^/.]+)",
    throttles: exponentialBackoff(
      "mobile_url_redirect_download/token",
      60,
      60,
      (request) => {
        if (request.method !== "GET" && request.method !== "HEAD") return undefined;
        const match = MOBILE_DOWNLOAD_PATH.exec(request.path)?.groups;
        return match ? `${match.token}/${match.file}` : undefined;
      },
      1,
    ),
  },
  {
    source: "\\A/(?:muse|claude|chatgpt)/v1/oauth2/register(?:\\.[^/]+)?\\z",
    throttles: exponentialBackoff("oauth_dynamic_registration/ip", 20, 60, (request, ip) =>
      matches(request, MCP_REGISTRATION_PATH, "POST") ? ip : undefined,
    ),
  },
  {
    source: "ends_with:/v2/sales",
    throttles: [
      {
        name: "/api/v2/sales",
        limit: 10,
        period: 1,
        discriminator: async (request, ip) =>
          request.path.endsWith("/v2/sales") && pageNumber((await request.params()).page) > 10 ? ip : undefined,
      },
    ],
  },
  {
    source: "\\A/(api/)?v2/products(\\.\\w+)?\\z",
    throttles: byIpOnRegexp(`/ip:${RUBY_REGEXP_NAMES.products}:post`, PRODUCTS_PATH, "POST", 10, 60),
  },
  {
    source: "\\A/(api/)?v2/products/comps(\\.\\w+)?\\z",
    throttles: [
      ...byIpOnRegexp(`/ip:${RUBY_REGEXP_NAMES.productsComps}:get`, PRODUCTS_COMPS_PATH, "GET", 30, 60),
      ...byTokenOnRegexp(`/params:${RUBY_REGEXP_NAMES.productsComps}:get`, PRODUCTS_COMPS_PATH, "GET", 30, 60),
    ],
  },
  {
    source: "\\A/(api/)?v2/products/[^/]+/preview_custom_html(\\.\\w+)?\\z",
    throttles: [
      ...byIpOnRegexp(`/ip:${RUBY_REGEXP_NAMES.productPreview}:post`, PRODUCT_PREVIEW_PATH, "POST", 60, 60),
      ...byTokenOnRegexp(`/params:${RUBY_REGEXP_NAMES.productPreview}:post`, PRODUCT_PREVIEW_PATH, "POST", 60, 60),
    ],
  },
  {
    source: "\\A/(api/)?v2/user/custom_html(\\.\\w+)?\\z",
    throttles: [
      ...byIpOnRegexp(`/ip:${RUBY_REGEXP_NAMES.userCustomHtml}:put`, USER_CUSTOM_HTML_PATH, "PUT", 30, 60),
      ...byIpOnRegexp(`/ip:${RUBY_REGEXP_NAMES.userCustomHtml}:patch`, USER_CUSTOM_HTML_PATH, "PATCH", 30, 60),
      ...byTokenOnRegexp(`/params:${RUBY_REGEXP_NAMES.userCustomHtml}:put`, USER_CUSTOM_HTML_PATH, "PUT", 30, 60),
      ...byTokenOnRegexp(`/params:${RUBY_REGEXP_NAMES.userCustomHtml}:patch`, USER_CUSTOM_HTML_PATH, "PATCH", 30, 60),
    ],
  },
  {
    source: "\\A/(api/)?v2/user/preview_custom_html(\\.\\w+)?\\z",
    throttles: [
      ...byIpOnRegexp(`/ip:${RUBY_REGEXP_NAMES.userPreview}:post`, USER_PREVIEW_PATH, "POST", 60, 60),
      ...byTokenOnRegexp(`/params:${RUBY_REGEXP_NAMES.userPreview}:post`, USER_PREVIEW_PATH, "POST", 60, 60),
    ],
  },
  {
    source: "\\A/(api/)?v2/media(\\.\\w+)?\\z",
    throttles: [
      ...byIpOnRegexp(`/ip:${RUBY_REGEXP_NAMES.media}:post`, MEDIA_PATH, "POST", 20, 600, 1),
      ...exponentialBackoff(
        "media_uploads/token",
        20,
        600,
        async (request) => (matches(request, MEDIA_PATH, "POST") ? await bearerOrAccessToken(request) : undefined),
        1,
      ),
    ],
  },
];

export const modelledSources = (): string[] => RULES.map((rule) => rule.source);

// The Redis key a throttle counts a discriminator under in the period containing `epoch` (seconds).
export const throttleKey = (throttle: Pick<Throttle, "name" | "period">, discriminator: string, epoch: number): string =>
  `${KEY_PREFIX}:${Math.floor(epoch / throttle.period)}:${throttle.name}:${discriminator}`;

// The throttles a request is counted in, with the discriminator each keys it by, in the order Rack::Attack evaluates them.
export async function matchingThrottles(
  request: ThrottleRequest,
  rules: ThrottleRule[] = RULES,
): Promise<{ throttle: Throttle; discriminator: string }[]> {
  const ip = rackRemoteIp(request.headers);
  const found: { throttle: Throttle; discriminator: string }[] = [];
  for (const throttle of rules.flatMap((rule) => rule.throttles)) {
    const discriminator = await throttle.discriminator(request, ip);
    if (discriminator) found.push({ throttle, discriminator });
  }
  return found;
}

export type RackAttackOutcome = {
  // Set when a throttle tripped: the Retry-After of Rack::Attack's default responder.
  throttled: { name: string; retryAfter: number } | null;
  // Takes back this request's increments, for a request Node hands to Rails (which counts it again).
  undo(): Promise<void>;
};

const NOTHING: RackAttackOutcome = { throttled: null, undo: async () => undefined };

export type CountOptions = { redis?: Redis; now?: () => number; rules?: ThrottleRule[] };

// Rack::Attack::Cache#count: INCRBY and EXPIRE in one pipeline, under `rack::attack:<period index>:<name>:<discriminator>`.
export async function countThrottles(request: ThrottleRequest, options: CountOptions = {}): Promise<RackAttackOutcome> {
  const ip = rackRemoteIp(request.headers);
  // safelist("allow from localhost")
  if (LOCALHOST.has(ip)) return NOTHING;
  const candidates = (options.rules ?? RULES).flatMap((rule) => rule.throttles);
  const redis = options.redis ?? getRedis("rackAttack");
  const incremented: string[] = [];
  const undo = async () => {
    if (incremented.length === 0) return;
    const pipeline = redis.pipeline();
    for (const key of incremented) pipeline.decr(key);
    await pipeline.exec();
  };
  for (const throttle of candidates) {
    const discriminator = await throttle.discriminator(request, ip);
    if (!discriminator) continue;
    const epoch = Math.floor((options.now ?? Date.now)() / 1000);
    // + 1 against the timing error Rack::Attack documents (rack-attack#85).
    const expiresIn = throttle.period - (epoch % throttle.period) + 1;
    const key = throttleKey(throttle, discriminator, epoch);
    const results = await redis.pipeline().incrby(key, 1).expire(key, expiresIn).exec();
    const count = Number(results?.[0]?.[1] ?? 1);
    incremented.push(key);
    if (count > throttle.limit)
      return { throttled: { name: throttle.name, retryAfter: throttle.period - (epoch % throttle.period) }, undo };
  }
  return { throttled: null, undo };
}

// Rack::Attack::Configuration::DEFAULT_THROTTLED_RESPONDER with throttled_response_retry_after_header on. It leaves Rack::Attack through the
// middleware ahead of it: SecureHeaders (without a CSP, which only a controller sets), the ETag middleware's `no-cache` and Rack::Cors.
export function throttledResponse(retryAfter: number): Response {
  return new Response("Retry later\n", {
    status: 429,
    headers: {
      "content-type": "text/plain",
      "retry-after": String(retryAfter),
      "cache-control": "no-cache",
      vary: "Origin",
      ...secureHeaders({ optOutOfCsp: true }),
    },
  });
}
