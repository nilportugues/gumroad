// What a YouTube, Instagram or TikTok callback that carries a code does once the state checks out (omniauth-phases.ts): the OAuth2 token
// exchange of the strategy, the calls its `auth_hash` makes, and the connect action of User::OmniauthCallbacksController that fetches the
// profile, writes the SocialConnectVerification and the identity and redirects.
//
// Every provider call goes through outboundFetch, in the order Rails makes it. Once the code is exchanged nothing can be handed back to
// Rails (the provider would refuse it a second time), so everything the Ruby code survives is answered here; `NotPorted` marks the few
// shapes whose Ruby behaviour is an exception message or class this port cannot reproduce (see parity-debt.md).
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { recordSocialConnectEvent } from "../models/social-connect-funnel.ts";
import {
  parseIso8601,
  presence,
  recordFromInstagram,
  recordFromTiktok,
  recordFromYoutube,
  RubyError,
  upsertIdentity,
  UserInstagramIdentities,
  UserTiktokIdentities,
  UserYoutubeIdentities,
} from "../models/social-connect-verification.ts";
import { isRecordNotUnique } from "../models/sql.ts";

import type { ActionResult } from "./application-controller.ts";
import { faradayQuery } from "./faraday-query.ts";
import { httpartyQuery } from "./httparty-response.ts";

export type SocialProvider = "youtube" | "instagram" | "tiktok";

const OAUTH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const FOUND = 302;
const HTTP_ERROR_MINIMUM = 400;
const HTTP_ERROR_LIMIT = 600;
const HTTP_SUCCESS_MINIMUM = 200;
const HTTP_SUCCESS_LIMIT = 300;
const REDIRECTING = new Set([301, 302, 303, 307]);
const LOGIN_PATH = "/login";
const BYTE_ORDER_MARK = 0xfeff;
const FORM = "application/x-www-form-urlencoded";

// The exception a Ruby code path raises that this port does not reproduce.
export class NotPorted extends Error {
  constructor(what: string) {
    super(`not ported: ${what}`);
    this.name = "NotPorted";
  }
}

type Hash = Record<string, unknown>;
const isHash = (value: unknown): value is Hash => value !== null && typeof value === "object" && !Array.isArray(value);

// OAuth2::Error: a refused request, an answer that is no token. The strategy ends it in `fail!(:invalid_credentials)`.
export class OAuth2Error extends Error {}
// A failure of the strategy itself, `fail!(message)` or a named kind.
export class StrategyFailure extends Error {
  constructor(readonly type: string) {
    super(type);
  }
}
class JsonParserError extends Error {}

// --- Parsing -----------------------------------------------------------------------------------------------------------------------

const OAUTH_JSON = new Set([
  "application/json",
  "text/javascript",
  "application/hal+json",
  "application/vnd.collection+json",
  "application/vnd.api+json",
  "application/problem+json",
]);
const XML = new Set([
  "text/xml",
  "application/rss+xml",
  "application/rdf+xml",
  "application/atom+xml",
  "application/xml",
]);

// An integer beyond 2**53 (an Instagram user id) stays exact, as Ruby's Integer does; it comes back as a bigint.
type Reviver = (key: string, value: unknown, context: { source: string }) => unknown;
const exactIntegers: Reviver = (_key, value, context) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  !Number.isSafeInteger(value) &&
  /^-?\d+$/u.test(context.source)
    ? BigInt(context.source)
    : value;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text, exactIntegers as Parameters<typeof JSON.parse>[1]) as unknown;
  } catch {
    throw new JsonParserError("unexpected token");
  }
}

// SnakyHash::Snake#underscore_string
function underscore(key: string): string {
  return key
    .trim()
    .replaceAll(" ", "_")
    .replaceAll("::", "/")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .replace(/_+/gu, "_")
    .toLowerCase();
}

function snaky(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snaky);
  if (!isHash(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [underscore(key), snaky(inner)]));
}

// OAuth2::Response#parsed: undefined where no parser applies (the response is not a hash then).
export function oauthParsed(contentType: string, text: string): unknown {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (OAUTH_JSON.has(type)) return snaky(parseJson(text));
  if (type === FORM) {
    const out: Hash = {};
    for (const [key, value] of new URLSearchParams(text)) {
      const seen = out[key];
      out[key] = seen === undefined ? value : Array.isArray(seen) ? [...(seen as unknown[]), value] : [seen, value];
    }
    return snaky(out);
  }
  if (type === "text/plain") return text;
  if (XML.has(type)) return {};
  return undefined;
}

// HTTParty::Parser#parse. A CSV body is an array of rows, which no caller reads further.
function httpartyParsed(contentType: string, text: string): unknown {
  if (text === "null" || text.trim() === "") return null;
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (["application/json", "application/vnd.api+json", "application/hal+json", "text/json"].includes(type))
    return parseJson(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
  if (type === "text/xml" || type === "application/xml") return {};
  if (type === "text/csv") return [[text]];
  return text;
}

// --- Ruby's dig --------------------------------------------------------------------------------------------------------------------

// Hash#dig / Array#dig: nil stops the walk, a value without #dig is a TypeError.
function dig(value: unknown, keys: (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || current === undefined) return null;
    if (Array.isArray(current)) {
      if (typeof key !== "number") throw new RubyError("TypeError", "no implicit conversion of String into Integer");
      current = current[key] ?? null;
    } else if (isHash(current)) {
      current = typeof key === "string" ? (current[key] ?? null) : null;
    } else {
      throw new RubyError("TypeError", "does not have #dig method");
    }
  }
  return current ?? null;
}

// `value&.dig(...)` on the parsed body of a fetch: a top-level scalar has no #dig at all.
function safeDig(value: unknown, keys: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new RubyError("NoMethodError", "undefined method 'dig'");
  return dig(value, keys);
}

// --- OAuth2 ------------------------------------------------------------------------------------------------------------------------

type Answer = { status: number; contentType: string; text: string };

async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Answer> {
  let response: Response;
  try {
    response = await outboundFetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new StrategyFailure("timeout");
    // SocketError: the host did not resolve.
    if (/ENOTFOUND|EAI_AGAIN/u.test(String((error as { cause?: { code?: string } }).cause?.code)))
      throw new StrategyFailure("failed_to_connect");
    throw error;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

// OAuth2::Client#request: a refused answer raises OAuth2::Error (after reading `error` out of the body, which a body that is not valid
// JSON under a JSON content type fails on first).
export async function oauthRequest(url: string, init: RequestInit): Promise<Answer> {
  const answer = await send(url, init, OAUTH_TIMEOUT_MS);
  if (REDIRECTING.has(answer.status)) throw new NotPorted("a redirect from a provider's OAuth2 endpoint");
  if (answer.status >= HTTP_ERROR_MINIMUM && answer.status < HTTP_ERROR_LIMIT) {
    oauthParsed(answer.contentType, answer.text);
    throw new OAuth2Error(`HTTP ${answer.status}`);
  }
  return answer;
}

type AccessToken = { token: string; refreshToken: unknown; expiresAt: number | null; params: Hash };

// Ruby's TOKEN_KEY_LOOKUP after SnakyHash has turned accessToken and idToken into their snake_case twins.
const TOKEN_KEYS = ["access_token", "id_token", "token"] as const;
// Ruby's truthiness: only nil and false are falsy (0 and "" are not).
const truthy = (value: unknown) => value !== null && value !== undefined && value !== false;

// OAuth2::AccessToken.from_hash and #initialize.
export function accessTokenFrom(hash: Hash, now: Date): AccessToken {
  const fresh = new Map(Object.entries(hash));
  const key = TOKEN_KEYS.find((candidate) => fresh.has(candidate));
  const token = key === undefined ? undefined : fresh.get(key);
  if (key !== undefined) fresh.delete(key);
  const text = token === null || token === undefined ? "" : String(token);
  const take = (name: string) => {
    const value = fresh.get(name);
    fresh.delete(name);
    return value;
  };
  const refreshToken = take("refresh_token");
  let expiresIn: unknown = take("expires_in");
  const expiresAtRaw = take("expires_at");
  const latency = take("expires_latency");
  if (text === "" && (refreshToken === null || refreshToken === undefined || refreshToken === ""))
    throw new OAuth2Error("no token");
  if (text === "") throw new NotPorted("a token answer with a refresh token and no access token");
  if (!truthy(expiresIn)) expiresIn = take("expires");
  const seconds = truthy(expiresIn) ? Number.parseInt(String(expiresIn), 10) || 0 : null;
  let expiresAt: number | null = null;
  if (truthy(expiresAtRaw)) {
    const time = Date.parse(String(expiresAtRaw));
    expiresAt = Number.isNaN(time) ? Number.parseInt(String(expiresAtRaw), 10) || 0 : Math.floor(time / 1000);
  }
  expiresAt ??= seconds === null ? null : Math.floor(now.getTime() / 1000) + seconds;
  if (expiresAt !== null && truthy(latency)) expiresAt -= Number.parseInt(String(latency), 10) || 0;
  return { token: text, refreshToken, expiresAt, params: Object.fromEntries(fresh) };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

type Strategy = {
  tokenUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  // `auth_scheme: :request_body` puts the credentials in the form; Google's default is HTTP Basic.
  basicAuth: boolean;
  tiktok: boolean;
  instagram: boolean;
};

const STRATEGIES: Record<SocialProvider, () => Strategy> = {
  youtube: () => ({
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: getConfig("GOOGLE_CLIENT_ID"),
    clientSecret: getConfig("GOOGLE_CLIENT_SECRET"),
    basicAuth: true,
    tiktok: false,
    instagram: false,
  }),
  instagram: () => ({
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    clientId: getConfig("INSTAGRAM_APP_ID"),
    clientSecret: getConfig("INSTAGRAM_APP_SECRET"),
    basicAuth: false,
    tiktok: false,
    instagram: true,
  }),
  tiktok: () => ({
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    clientId: getConfig("TIKTOK_CLIENT_KEY"),
    clientSecret: getConfig("TIKTOK_CLIENT_SECRET"),
    basicAuth: false,
    tiktok: true,
    instagram: false,
  }),
};

// OAuth2::Strategy::AuthCode#get_token through Client#get_token: a form POST with the keys sorted (Faraday).
async function exchange(strategy: Strategy, code: string, callbackUrl: string, now: Date): Promise<AccessToken> {
  const params: Record<string, string | null> = { grant_type: "authorization_code", code, redirect_uri: callbackUrl };
  const headers: Record<string, string> = { "Content-Type": FORM };
  if (strategy.basicAuth)
    headers.Authorization = `Basic ${Buffer.from(`${strategy.clientId ?? ""}:${strategy.clientSecret ?? ""}`).toString("base64")}`;
  else {
    if (strategy.clientId !== undefined) params.client_id = strategy.clientId;
    if (strategy.clientSecret !== undefined) params.client_secret = strategy.clientSecret;
  }
  if (strategy.tiktok) {
    params.client_key = strategy.clientId ?? null;
    params.client_secret = strategy.clientSecret ?? null;
  }
  const answer = await oauthRequest(strategy.tokenUrl, { method: "POST", headers, body: faradayQuery(params) });
  let parsed = oauthParsed(answer.contentType, answer.text);
  if (!isHash(parsed) || Object.keys(parsed).length === 0) throw new OAuth2Error("no token answer");
  if (strategy.instagram) {
    // WrappedAccessToken.from_hash: the first element of "data" when the answer has one.
    const data = "data" in parsed ? parsed.data : [];
    if (!Array.isArray(data)) throw new NotPorted("an Instagram token answer whose data is not an array");
    const first = ((data as unknown[])[0] ?? null) as unknown;
    if (first !== null && first !== false && !isHash(first))
      throw new NotPorted("an Instagram token answer with a data element that is no hash");
    parsed = (first as Hash | null) || parsed;
  }
  const token = accessTokenFrom(parsed as Hash, now);
  if (token.expiresAt !== null && token.expiresAt <= Math.floor(now.getTime() / 1000)) {
    if (!token.refreshToken) throw new StrategyFailure("A refresh_token is not available");
    throw new NotPorted("an access token that is expired when it arrives and can be refreshed");
  }
  return token;
}

// --- Google's auth_hash -------------------------------------------------------------------------------------------------------------

const ALLOWED_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const JWT_LEEWAY_SECONDS = 60;

function claimString(value: unknown): string {
  return value === null || value === undefined ? "<none>" : String(value);
}

// JWT.decode(token, nil, false).first then JWT::Verify.verify_claims with the claims the strategy asks for (iss, aud, exp, nbf).
function verifyIdToken(token: string, audience: string | undefined, now: Date): void {
  if (token === "") return;
  const segments = token.split(".");
  if (segments.length !== 2 && segments.length !== 3) throw new StrategyFailure("Not enough or too many segments");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
  } catch {
    throw new StrategyFailure("Invalid segment encoding");
  }
  if (!isHash(payload)) throw new NotPorted("an ID token whose payload is not a JSON object");
  const issuer = payload.iss;
  if (!ALLOWED_ISSUERS.includes(issuer as string))
    throw new StrategyFailure(
      `Invalid issuer. Expected ${JSON.stringify(ALLOWED_ISSUERS).replaceAll(",", ", ")}, received ${claimString(issuer)}`,
    );
  const wanted = audience === undefined ? [] : [audience];
  const given =
    payload.aud === null || payload.aud === undefined ? [] : Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!given.some((aud) => wanted.includes(aud as string)))
    throw new StrategyFailure(`Invalid audience. Expected ${audience ?? ""}, received ${claimString(payload.aud)}`);
  const seconds = Math.floor(now.getTime() / 1000);
  if ("exp" in payload && Math.trunc(Number(payload.exp)) <= seconds - JWT_LEEWAY_SECONDS)
    throw new StrategyFailure("Signature has expired");
  if ("nbf" in payload && Math.trunc(Number(payload.nbf)) > seconds + JWT_LEEWAY_SECONDS)
    throw new StrategyFailure("Signature nbf has not been reached");
}

// The `credentials` and `extra` blocks of GoogleOauth2 (tokeninfo, the ID token, user info), which `auth_hash` evaluates in that order.
// The connect action reads none of what they return; they matter as calls that can end the callback.
async function googleAuthHash(token: AccessToken, idToken: unknown, now: Date): Promise<void> {
  const info = await oauthRequest(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?${faradayQuery({ access_token: token.token })}`,
    { method: "GET" },
  );
  oauthParsed(info.contentType, info.text);
  const jwt = typeof idToken === "string" && idToken !== "" ? idToken : token.token;
  verifyIdToken(jwt, getConfig("GOOGLE_CLIENT_ID"), now);
  const user = await oauthRequest("https://www.googleapis.com/oauth2/v3/userinfo", {
    method: "GET",
    headers: bearer(token.token),
  });
  oauthParsed(user.contentType, user.text);
}

// --- The exchange as the strategy runs it ------------------------------------------------------------------------------------------------

export type Exchanged = { ok: true; token: string; uid: unknown } | { ok: false; type: string };

// OmniAuth::Strategies::OAuth2#callback_phase from `build_access_token` on. A failure is the type the failure action receives.
export async function exchangeCode(
  provider: SocialProvider,
  code: string,
  callbackUrl: string,
  now: Date,
): Promise<Exchanged> {
  try {
    const token = await exchange(STRATEGIES[provider](), code, callbackUrl, now);
    if (provider === "youtube") await googleAuthHash(token, token.params.id_token, now);
    const uid =
      provider === "instagram"
        ? (token.params.user_id ?? null)
        : provider === "tiktok"
          ? (token.params.open_id ?? null)
          : null;
    return { ok: true, token: token.token, uid };
  } catch (error) {
    if (error instanceof OAuth2Error) return { ok: false, type: "invalid_credentials" };
    if (error instanceof StrategyFailure) return { ok: false, type: error.type };
    throw error;
  }
}

// --- The fetchers (HTTParty) -------------------------------------------------------------------------------------------------------

// HTTParty.get(...).parsed_response when the answer is a success, nil (undefined here) otherwise. A network failure or a JSON body that
// does not parse raises what the fetchers rescue as a whole: FetchRescued.
async function getJson(url: string, pairs: [string, string][], token: string): Promise<unknown> {
  let answer: Answer;
  try {
    answer = await send(`${url}?${httpartyQuery(pairs)}`, { method: "GET", headers: bearer(token) }, FETCH_TIMEOUT_MS);
  } catch {
    throw new FetchRescued();
  }
  if (answer.status < HTTP_SUCCESS_MINIMUM || answer.status >= HTTP_SUCCESS_LIMIT) return undefined;
  try {
    return httpartyParsed(answer.contentType, answer.text);
  } catch {
    throw new FetchRescued();
  }
}

class FetchRescued extends Error {}

const blank = (value: unknown) => presence(value) === null;

// YoutubeChannelFetcher#fetch. The action rescues every StandardError, so any failure along the way is "no channel".
async function fetchYoutubeChannel(token: string): Promise<Hash | null> {
  if (token.trim() === "") return null;
  try {
    const channel = await getJson(
      "https://www.googleapis.com/youtube/v3/channels",
      [
        ["part", "snippet,statistics,contentDetails"],
        ["mine", "true"],
      ],
      token,
    );
    const item = channel === undefined ? null : safeDig(channel, ["items", 0]);
    if (blank(item) || !isHash(item) || blank(item.id)) return null;
    const custom = dig(item, ["snippet", "customUrl"]);
    let handle: string | null = null;
    if (!blank(custom)) {
      if (typeof custom !== "string") return null;
      handle = custom.replace(/^@/u, "").replace(/^\//u, "");
    }
    const publishedAt = dig(item, ["snippet", "publishedAt"]);
    const subscribers = dig(item, ["statistics", "subscriberCount"]);
    const videos = dig(item, ["statistics", "videoCount"]);
    const uploads = dig(item, ["contentDetails", "relatedPlaylists", "uploads"]);
    let lastPostedAt: Date | null = null;
    if (!blank(uploads)) {
      const playlist = await getJson(
        "https://www.googleapis.com/youtube/v3/playlistItems",
        [
          ["part", "snippet"],
          ["playlistId", String(uploads)],
          ["maxResults", "1"],
        ],
        token,
      );
      const published = playlist === undefined ? null : safeDig(playlist, ["items", 0, "snippet", "publishedAt"]);
      if (!blank(published)) {
        if (typeof published !== "string") return null;
        lastPostedAt = parseIso8601(published);
      }
    }
    return {
      id: item.id,
      handle,
      published_at: publishedAt,
      subscriber_count: subscribers,
      video_count: videos,
      last_posted_at: lastPostedAt,
    };
  } catch (error) {
    if (error instanceof NotPorted) throw error;
    return null;
  }
}

const INSTAGRAM_API_VERSION = () => getConfig("INSTAGRAM_API_VERSION", "v25.0");
const INSTAGRAM_GRAPH = "https://graph.instagram.com";

// InstagramProfileFetcher#fetch. Errors the fetcher does not rescue (a TypeError out of dig) reach the action's rescue as their class name.
async function fetchInstagramProfile(token: string): Promise<Hash | null> {
  if (token.trim() === "") return null;
  const response = await getJson(
    `${INSTAGRAM_GRAPH}/${INSTAGRAM_API_VERSION()}/me`,
    [["fields", "user_id,username,followers_count,media_count"]],
    token,
  );
  if (!isHash(response)) return null;
  const profile = "data" in response ? dig(response, ["data", 0]) : response;
  if (!isHash(profile)) return null;
  const uid = presence(profile.user_id) ?? presence(profile.id);
  if (uid === null) return null;
  const media = await getJson(
    `${INSTAGRAM_GRAPH}/${INSTAGRAM_API_VERSION()}/${String(uid)}/media`,
    [
      ["fields", "timestamp"],
      ["limit", "1"],
    ],
    token,
  );
  return { ...profile, last_posted_at: safeDig(media, ["data", 0, "timestamp"]) };
}

// TiktokProfileFetcher#fetch
async function fetchTiktokProfile(token: string): Promise<Hash | null> {
  if (token.trim() === "") return null;
  const body = await getJson(
    "https://open.tiktokapis.com/v2/user/info/",
    [["fields", "open_id,union_id,avatar_url,display_name,username,profile_web_link,follower_count,video_count"]],
    token,
  ).catch((error: unknown) => {
    if (error instanceof FetchRescued) return undefined;
    throw error;
  });
  if (!isHash(body)) return null;
  const errorCode = dig(body, ["error", "code"]);
  if (!blank(errorCode) && errorCode !== "ok") return null;
  const user = dig(body, ["data", "user"]);
  if (!isHash(user) || blank(user.open_id)) return null;
  return user;
}

// --- The connect actions -----------------------------------------------------------------------------------------------------------

type Connect = {
  userId: bigint | null;
  token: string;
  uid: unknown;
  // The page the flow started from when its return token checks out, else the social connections settings.
  destination: string;
  now: () => Date;
};

const LABEL: Record<SocialProvider, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
const redirect = (location: string, alert?: string): ActionResult => ({
  status: FOUND,
  location,
  ...(alert === undefined ? {} : { flash: { alert } }),
});

const failedEvent = (provider: SocialProvider, userId: bigint, extra: string, now: () => Date) =>
  recordSocialConnectEvent({ userId, stage: "failed", provider, surface: "omniauth", extra, now });

// The class name an exception reaches the action's `rescue StandardError` with.
function rubyClassOf(error: unknown): string {
  if (error instanceof RubyError && error.rubyClass !== "NotPorted") return error.rubyClass;
  if (error instanceof FetchRescued) return "";
  if (error instanceof RecordInvalid) return "ActiveRecord::RecordInvalid";
  if (isRecordNotUnique(error)) return "ActiveRecord::RecordNotUnique";
  throw error;
}

// User::OmniauthCallbacksController#youtube, #instagram and #tiktok after the flag check (the strategy checked the same actor).
export async function connectAccount(provider: SocialProvider, connect: Connect): Promise<ActionResult> {
  const { userId, token, destination, now } = connect;
  if (userId === null) return redirect(LOGIN_PATH, `You need to be logged in to link your ${LABEL[provider]} account.`);
  const saveFailure = `Couldn't save your ${LABEL[provider]} connection. Please try again.`;

  if (provider === "youtube") {
    const channel = await fetchYoutubeChannel(token);
    if (channel === null) {
      await failedEvent(provider, userId, "no_channel", now);
      return redirect(destination, "Couldn't read a YouTube channel for that Google account.");
    }
    try {
      await recordFromYoutube(userId, channel, now);
      await upsertIdentity(
        UserYoutubeIdentities,
        "user_youtube_identities",
        userId,
        { channel_id: String(channel.id), handle: channel.handle as string | null },
        now,
      );
    } catch (error) {
      await failedEvent(provider, userId, rubyClassOf(error), now);
      return redirect(destination, saveFailure);
    }
    return redirect(destination);
  }

  try {
    let profile: Hash | null;
    try {
      profile = provider === "instagram" ? await fetchInstagramProfile(token) : await fetchTiktokProfile(token);
    } catch (error) {
      // The fetcher's own rescue: nil, so "no profile".
      if (!(error instanceof FetchRescued)) throw error;
      profile = null;
    }
    if (profile === null) {
      await failedEvent(provider, userId, "no_profile", now);
      return redirect(
        destination,
        provider === "instagram"
          ? "Couldn't read an Instagram professional account."
          : "Couldn't read a TikTok account.",
      );
    }
    const verification =
      provider === "instagram"
        ? await recordFromInstagram(userId, { ...profile, token_user_id: connect.uid }, now)
        : await recordFromTiktok(userId, profile, now);
    if (verification === null) {
      await failedEvent(provider, userId, "blank_verification", now);
      return redirect(destination, saveFailure);
    }
    const attributes = { handle: verification.get("handle") };
    if (provider === "instagram")
      await upsertIdentity(
        UserInstagramIdentities,
        "user_instagram_identities",
        userId,
        { instagram_user_id: verification.get("uid"), ...attributes },
        now,
      );
    else
      await upsertIdentity(
        UserTiktokIdentities,
        "user_tiktok_identities",
        userId,
        { tiktok_open_id: verification.get("uid"), ...attributes },
        now,
      );
    return redirect(destination);
  } catch (error) {
    await failedEvent(provider, userId, rubyClassOf(error), now);
    return redirect(destination, saveFailure);
  }
}
