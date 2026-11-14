// The parts of GoogleCalendarApi (app/services/google_calendar_api.rb) that more than one caller needs: every call to the Calendar
// API goes through the shared `GOOGLE_CALENDAR_API_RATE_LIMIT` Ratelimit, the token refresh does not, and the event insert posts JSON
// the way HTTParty hands Net::HTTP a string body.
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { activeSupportJson } from "../webhooks/json-guards.ts";

import { FORM_CONTENT_TYPE, parseHttpParty, postForm, type ParsedResponse } from "./http-party.ts";
import { Ratelimit } from "./ratelimit.ts";

const OAUTH_URL = "https://oauth2.googleapis.com";
const API_URL = "https://www.googleapis.com";
const RATE_LIMIT_KEY = "GOOGLE_CALENDAR_API_RATE_LIMIT";
const RATE_LIMIT_THRESHOLD = 10_000;
const RATE_LIMIT_INTERVAL_SECONDS = 60;

// GoogleCalendarApi#rate_limited_call
export async function rateLimited(call: () => Promise<ParsedResponse>): Promise<ParsedResponse> {
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

// GoogleCalendarApi#refresh_token
export const refreshToken = async (token: string | undefined) =>
  parseHttpParty(
    await postForm(`${OAUTH_URL}/token`, [
      ["grant_type", "refresh_token"],
      ["refresh_token", token],
      ["client_id", getConfig("GOOGLE_CLIENT_ID")],
      ["client_secret", getConfig("GOOGLE_CLIENT_SECRET")],
    ]),
  );

// GoogleCalendarApi#insert_event: `event.to_json` as the body, which Net::HTTP sends as a form because HTTParty names no type.
export const insertEvent = (calendarId: string, event: unknown, accessToken: string) =>
  rateLimited(async () =>
    parseHttpParty(
      await outboundFetch(`${API_URL}/calendar/v3/calendars/${calendarId}/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": FORM_CONTENT_TYPE },
        body: activeSupportJson(event),
      }),
    ),
  );
