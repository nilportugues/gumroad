// Integrations::GoogleCalendarController#account_info and #calendar_list (GET /integrations/google_calendar/*): the signed-in seller's
// Google account and calendars, behind an OAuth code. #oauth_redirect renders the application layout (integrations-oauth-redirect.ts).
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import {
  digParsed,
  isHash,
  isPresent,
  parseHttpParty,
  postForm,
  urlEncode,
  type ParsedResponse,
} from "../services/http-party.ts";
import { Ratelimit } from "../services/ratelimit.ts";

import { HandBackToRails } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations } from "./mutation.ts";

const OAUTH_URL = "https://oauth2.googleapis.com";
const API_URL = "https://www.googleapis.com";
const OAUTH_REDIRECT_PATH = "/integrations/google_calendar/oauth_redirect";
const RATE_LIMIT_KEY = "GOOGLE_CALENDAR_API_RATE_LIMIT";
const RATE_LIMIT_THRESHOLD = 10_000;
const RATE_LIMIT_INTERVAL_SECONDS = 60;
const HTTP_UNAUTHORIZED = 401;

const failure = () => jsonResponse({ success: false }, 200, true);

// A parameter Rails encodes as one value, or as a bare key when absent; a list or hash encodes differently, so Rails decides.
function stringParam(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HandBackToRails(`a ${name} that is not a string`);
  return value;
}

// GoogleCalendarApi#rate_limited_call
async function rateLimited(call: () => Promise<ParsedResponse>): Promise<ParsedResponse> {
  const ratelimit = new Ratelimit(RATE_LIMIT_KEY);
  return ratelimit.execWithinThreshold(
    RATE_LIMIT_KEY,
    { threshold: RATE_LIMIT_THRESHOLD, interval: RATE_LIMIT_INTERVAL_SECONDS },
    async () => {
      await ratelimit.add(RATE_LIMIT_KEY);
      return call();
    },
  );
}

// GoogleCalendarApi#oauth_token and #refresh_token
const oauthToken = async (code: string | undefined, redirectUri: string) =>
  parseHttpParty(
    await postForm(`${OAUTH_URL}/token`, [
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", redirectUri],
      ["client_id", getConfig("GOOGLE_CLIENT_ID")],
      ["client_secret", getConfig("GOOGLE_CLIENT_SECRET")],
    ]),
  );

const refreshToken = async (token: string | undefined) =>
  parseHttpParty(
    await postForm(`${OAUTH_URL}/token`, [
      ["grant_type", "refresh_token"],
      ["refresh_token", token],
      ["client_id", getConfig("GOOGLE_CLIENT_ID")],
      ["client_secret", getConfig("GOOGLE_CLIENT_SECRET")],
    ]),
  );

const userInfo = (token: string) =>
  rateLimited(async () =>
    parseHttpParty(await outboundFetch(`${API_URL}/oauth2/v2/userinfo?access_token=${urlEncode(token)}`)),
  );

const calendarList = (token: string | undefined) =>
  rateLimited(async () =>
    parseHttpParty(
      await outboundFetch(`${API_URL}/calendar/v3/users/me/calendarList`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      }),
    ),
  );

// `items.map { |c| c.slice("id", "summary") }`: an empty hash maps to [], a non-empty one yields [key, value] pairs that cannot be sliced.
function sliceCalendars(items: unknown): Record<string, unknown>[] {
  if (isHash(items) && Object.keys(items).length === 0) return [];
  if (!Array.isArray(items)) throw new Error("Google answered a calendar list without items");
  return items.map((item) => {
    if (!isHash(item)) throw new Error("Google answered a calendar that is not a JSON object");
    const slice: Record<string, unknown> = {};
    for (const key of ["id", "summary"]) if (Object.hasOwn(item, key)) slice[key] = item[key];
    return slice;
  });
}

registerMutations(
  {
    method: "GET",
    pattern: "/integrations/google_calendar/account_info",
    json: true,
    skipForgeryProtection: true,
    formats: ["any"],
    run: async ({ request, params }) => {
      const code = stringParam(params.code, "OAuth code");
      const oauth = await oauthToken(code, `${request.protocol}${request.hostWithPort}${OAUTH_REDIRECT_PATH}`);
      const accessToken = digParsed(oauth.parsed, "access_token");
      const refresh = digParsed(oauth.parsed, "refresh_token");
      if (!oauth.ok || !isPresent(accessToken) || !isPresent(refresh)) return failure();

      const user = await userInfo(String(accessToken));
      const email = digParsed(user.parsed, "email");
      if (!user.ok || !isPresent(email)) return failure();

      return jsonResponse({ success: true, access_token: accessToken, refresh_token: refresh, email }, 200, true);
    },
  },
  {
    method: "GET",
    pattern: "/integrations/google_calendar/calendar_list",
    json: true,
    skipForgeryProtection: true,
    formats: ["any"],
    run: async ({ params }) => {
      let list = await calendarList(stringParam(params.access_token, "access token"));

      if (list.status === HTTP_UNAUTHORIZED) {
        const refreshed = await refreshToken(stringParam(params.refresh_token, "refresh token"));
        const accessToken = digParsed(refreshed.parsed, "access_token");
        if (!refreshed.ok || !isPresent(accessToken)) return failure();
        list = await calendarList(String(accessToken));
      }
      if (!list.ok) return failure();

      // `parsed_response["items"]` raises on a body that is not a hash (nil has no `[]`; a string answers a substring).
      if (!isHash(list.parsed)) throw new Error("Google answered a calendar list that is not a JSON object");
      return jsonResponse({ success: true, calendar_list: sliceCalendars(list.parsed.items) }, 200, true);
    },
  },
);
