// AnalyticsController#data_by_date, #data_by_state and #data_by_referral: the JSON the sales analytics charts
// fetch for a date range. Sellers::BaseController runs RequireAccountEmail and authenticate_user!, then
// `set_time_range`, then the action authorizes `:analytics`.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { CreatorAnalyticsCachingProxy } from "../page-props/analytics/caching-proxy.ts";
import { parseRailsDate } from "../page-props/analytics/churn.ts";
import { CreatorAnalyticsWeb, type AnalyticsSeller } from "../page-props/analytics/creator-analytics-web.ts";
import { rackParam } from "../page-props/audience/support.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { analyticsPolicy } from "../policies/seller-analytics.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";
import { addDays, civilDateInZone, TimeZoneNotPortedError } from "../search/civil-time.ts";
import { MAX_HOURLY_DATE_RANGE_DAYS } from "../search/creator-analytics-sales.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";

import {
  type ActionContext,
  type ActionOptions,
  type ActionResult,
  HandBackToRails,
  processAction,
  type Rendered,
} from "./application-controller.ts";
import { assertFlatQuery, requestFormat } from "./rails-params.ts";

const ADD_EMAIL_MESSAGE = "Please add an email address to your account before continuing.";
const DEFAULT_RANGE_DAYS = 29;
const JSON_TYPE = "application/json; charset=utf-8";

// `render json:` answers Vary: Accept (params_read is not set by `params[...]` reads on this request).
const json = (value: unknown, status = 200, paramsRead = false): Rendered => ({
  status,
  body: esJson(value as JsonValue),
  contentType: JSON_TYPE,
  paramsRead,
});

// ApplicationController#strip_timestamp_location: `timestamp.gsub(/([^(]+).*/, '\1').strip`, nil for nil. An array
// param has no gsub (NoMethodError), which set_time_range rescues like a parse failure: null. gsub keeps any
// leading "(" characters and replaces the first run after them with its capture, so only that run survives.
// A line break (`.` stops there) is not modeled and goes to Rails.
export function stripTimestampLocation(value: string | string[] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  if (/[\r\n]/u.test(value)) throw new HandBackToRails();
  return /^\(*[^(]*/u.exec(value)![0].trim();
}

// AnalyticsController#set_time_range: any parse failure (a missing param too) falls back to the trailing 30 days.
export function timeRange(queryString: string, now: Date): { startDate: string; endDate: string } {
  const query = { queryString };
  const endText = stripTimestampLocation(rackParam(query, "end_time"));
  const end = endText === null ? null : parseRailsDate(endText);
  const startText = endText === null ? null : stripTimestampLocation(rackParam(query, "start_time"));
  const start = startText === null ? null : parseRailsDate(startText);
  if (end !== null && start !== null) return { startDate: start, endDate: end };
  const today = civilDateInZone(now.getTime(), "Etc/UTC");
  return { startDate: addDays(today, -DEFAULT_RANGE_DAYS), endDate: today };
}

// RequireAccountEmail: a signed-in user without an email, outside impersonation, is answered by format.
function accountEmailRequired({ context, request }: ActionContext): ActionResult | null {
  const user = railsLoggedInUser(context);
  if (!user || user.email || user.unconfirmed_email || context.impersonatedUser) return null;
  switch (requestFormat(request)) {
    case "json":
      return { ...json({ success: false, error_message: ADD_EMAIL_MESSAGE }, 403), rescued: true };
    case "html":
      return { status: 302, location: "/settings", flash: { warning: ADD_EMAIL_MESSAGE }, rescued: true };
    default:
      throw new HandBackToRails();
  }
}

async function respond(action: ActionContext, by: "date" | "state" | "referral"): Promise<ActionResult> {
  const halted = accountEmailRequired(action);
  if (halted) return halted;
  const { request, context } = action;
  if (!railsLoggedInUser(context) || !context.currentSeller) throw new HandBackToRails();
  assertFlatQuery(request.queryString);
  const { startDate, endDate } = timeRange(request.queryString, new Date());
  const seller = context.currentSeller as AnalyticsSeller & { user_risk_state?: string | null };

  const sellerContext = await loadSellerContext(context);
  try {
    if (!analyticsPolicy.index(sellerContext)) throw new NotAuthorizedError();
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    // PunditAuthorization#default_user_not_authorized
    const message = notAllowedMessage(sellerContext);
    switch (requestFormat(request)) {
      case "json":
        return { ...json({ success: false, error: message }, 401), rescued: true };
      default:
        return {
          status: 302,
          location: "/dashboard",
          ...(request.queryString.includes("account_switched") ? {} : { flash: { alert: message } }),
          rescued: true,
        };
    }
  }

  try {
    if (by === "referral" && rackParam({ queryString: request.queryString }, "interval") === "hour") {
      if (endDate < startDate) return json({ error: "Invalid date range." }, 400);
      const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000);
      if (days > MAX_HOURLY_DATE_RANGE_DAYS)
        return json(
          { error: `Date range cannot exceed ${MAX_HOURLY_DATE_RANGE_DAYS} days for the hourly interval.` },
          400,
        );
      // Hourly data bypasses the cache, which only stores day-keyed data.
      const dates: string[] = [];
      for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
      return json(await new CreatorAnalyticsWeb(seller, dates, null, "hour").byReferral());
    }
    return json(await new CreatorAnalyticsCachingProxy(seller).dataForDates(startDate, endDate, by));
  } catch (error) {
    // A midnight that does not exist (a DST change at 00:00) is a boundary the port cannot compute.
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails();
    throw error;
  }
}

export const ANALYTICS_DATA_OPTIONS: ActionOptions = {};

export function analyticsDataResponse(by: "date" | "state" | "referral") {
  return (incoming: Request): Promise<Response> =>
    processAction(incoming, ANALYTICS_DATA_OPTIONS, (action) => respond(action, by));
}
