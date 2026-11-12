// Port of app/sidekiq/google_calendar_invite_job.rb: inserts the call as an event in the seller's Google calendar (refreshing the
// access token once on a 401) and keeps the event id on the call. The Google calls go through the shared rate limit and the
// event is inserted at most once per call.
//
// Everything that happens after the first Google request is reproduced, because Rails could not re-run it without inserting the event
// twice. What Node cannot reproduce there fails the job instead of handing it back: an event id or access token Google answers as
// anything but a string, number or null. Only arguments are checked before the request, and a calendar id or token Ruby's URI and
// header handling might treat differently is handed back before it.
// Golden: __fixtures__/google-calendar-invite-job.golden.json (scripts/golden/google-calendar-invite-job.rb).
import type { Call, Link, Purchase, User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { Calls } from "../../server/models/call.ts";
import {
  findProductGoogleCalendarIntegration,
  GoogleCalendarIntegrations,
  integrationDetail,
  setIntegrationDetail,
  type GoogleCalendarIntegrationRecord,
} from "../../server/models/google-calendar-integration.ts";
import { findById, findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { insertEvent, refreshToken } from "../../server/services/google-calendar-api.ts";
import { isHash, type ParsedResponse } from "../../server/services/http-party.ts";

import { modelJob } from "./support/job-deps.ts";

const HTTP_UNAUTHORIZED = 401;
const NATIVE_TYPE_CALL = "call";
// What Google's calendar ids and OAuth tokens are made of; anything else could reach Net::HTTP differently than fetch.
const SAFE_CALENDAR_ID = /^[A-Za-z0-9._@-]*$/u;
const SAFE_TOKEN = /^[A-Za-z0-9._~+/=-]+$/u;

class RubyError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// `parsed_response[key]`, as Ruby indexes what HTTParty parsed: a hash by key, a string by substring, and a raise for the rest.
function rubyIndex(parsed: unknown, key: string): unknown {
  if (isHash(parsed)) return parsed[key] ?? null;
  if (typeof parsed === "string") return parsed.includes(key) ? key : null;
  if (parsed === null || parsed === undefined) throw new RubyError("NoMethodError", "undefined method '[]' for nil");
  if (typeof parsed === "boolean") throw new RubyError("NoMethodError", `undefined method '[]' for ${String(parsed)}`);
  if (typeof parsed === "number" && !Number.isInteger(parsed))
    throw new RubyError("NoMethodError", "undefined method '[]' for an instance of Float");
  throw new RubyError("TypeError", "no implicit conversion of String into Integer");
}

// ActiveModel's String type casting of what Google answered for an id, for the values Ruby renders the same way.
function castToString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "number" && !String(value).includes("e")) return String(value);
  if (value === true) return "1";
  throw new RubyError("NotPortedError", `an event id Google answered as ${JSON.stringify(value)}`);
}

const iso8601 = (time: Date | null): string => {
  if (time === null) throw new RubyError("NoMethodError", "undefined method 'iso8601' for nil");
  return `${time.toISOString().slice(0, 19)}Z`;
};

export const googleCalendarInviteJobWith = modelJob({ min: 1 }, async ([callId], deps) => {
  const id = await beforeSideEffects(() => recordIdFrom(callId, "Call.find"));
  const call = await findByIdBang<Call>("Call", id);
  if (call.google_calendar_event_id !== null && call.google_calendar_event_id.trim() !== "") return;

  // `call.link` delegates to the purchase.
  const purchase = await findById<Purchase>("Purchase", call.purchase_id);
  if (purchase === null) throw new RubyError("DelegationError", "link delegated to purchase, but purchase is nil");
  const link = await findById<Link>("Link", purchase.link_id);
  const purchaser = await findById<User>("User", purchase.purchaser_id);
  const buyer = purchaser?.email ?? purchase.email;
  if (link === null) throw new RubyError("NoMethodError", "undefined method 'get_integration' for nil");

  const integration = await findProductGoogleCalendarIntegration(link.id);
  if (integration === null) return;

  const event = {
    summary: `Call with ${buyer}`,
    description: `Scheduled call for ${link.name}`,
    start: { dateTime: iso8601(call.start_time) },
    end: { dateTime: iso8601(call.end_time) },
    attendees: [{ email: buyer }],
    reminders: { useDefault: true },
  };

  const calendarId = integrationDetail(integration, "calendar_id");
  const accessToken = integrationDetail(integration, "access_token");
  await beforeSideEffects(() => {
    if (calendarId !== null && (typeof calendarId !== "string" || !SAFE_CALENDAR_ID.test(calendarId)))
      throw new HandBackToRuby("a calendar id Ruby's URI parser may read differently");
    if (typeof accessToken !== "string" || !SAFE_TOKEN.test(accessToken))
      throw new HandBackToRuby("an access token Net::HTTP may send differently");
  });
  const calendar = (calendarId as string | null) ?? "";

  const insert = (token: string) => insertEvent(calendar, event, token);
  let response: ParsedResponse = await insert(accessToken as string);
  if (!response.ok && response.status === HTTP_UNAUTHORIZED) {
    const refreshed = await refreshAccessToken(integration, deps.now);
    if (refreshed !== null) response = await insert(refreshed);
  }
  if (!response.ok) return;

  const eventId = castToString(rubyIndex(response.parsed, "id"));
  // The validations the update runs, on the associations already loaded (`update` is false, quietly, when one fails).
  if (call.start_time === null || call.end_time === null) return;
  if (call.start_time.getTime() >= call.end_time.getTime()) return;
  if (link.native_type !== NATIVE_TYPE_CALL) return;
  await Calls.update(Calls.load(call), { google_calendar_event_id: eventId }, { validate: false, now: deps.now });
});

// `refresh_token`: the new access token when Google gives one (kept on the integration), null when the refresh fails.
async function refreshAccessToken(
  integration: GoogleCalendarIntegrationRecord,
  now: () => Date,
): Promise<string | null> {
  const stored = integrationDetail(integration, "refresh_token");
  const refresh = await refreshToken(typeof stored === "string" ? stored : undefined);
  if (!refresh.ok) return null;
  const token = rubyIndex(refresh.parsed, "access_token");
  if (token !== null && typeof token !== "string")
    throw new RubyError("NotPortedError", "an access token Google answered as something but a string");
  setIntegrationDetail(integration, "access_token", token);
  await GoogleCalendarIntegrations.save(integration, { now });
  return token;
}

export const googleCalendarInviteJob = googleCalendarInviteJobWith();
