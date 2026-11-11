// Products::RemainingCallAvailabilitiesController#index and Product::ComputeCallAvailabilitiesService. Public: the product page
// asks it for the slots a buyer can still book. Reads only.
import { Prisma } from "@prisma/client";

import {
  calendarDateInTimeZone,
  type CalendarDate,
  endOfDayInstant,
  instantInTimeZoneIso8601,
  isKnownTimeZone,
  startOfDayInstant,
} from "../models/concerns/rails-time-zone.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { PurchaseFlags } from "../search/flags.ts";

import {
  type ActionContext,
  type ActionResult,
  HandBackToRails,
  processAction,
  RoutingError,
} from "./application-controller.ts";
import { json } from "./seller-json.ts";

const NATIVE_TYPE_CALL = "call";
const MINUTE_MS = 60_000;
// Purchase.counts_towards_inventory
const INVENTORY_PURCHASE_STATES = [
  "preorder_authorization_successful",
  "in_progress",
  "successful",
  "not_charged",
] as const;

export type Interval = { start: number; end: number };

export type ComputeInput = {
  zone: string;
  now: number;
  availabilities: Interval[];
  // The seller's booked calls across all their products, and the starts of those booked on this product.
  sellerBookings: Interval[];
  productBookingStarts: number[];
  minimumNoticeInMinutes: number | null;
  maximumCallsPerDay: number | null;
};

const dateKey = ({ year, month, day }: CalendarDate) => `${year}-${month}-${day}`;
const addDays = ({ year, month, day }: CalendarDate, days: number): CalendarDate => {
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
};
const dayNumber = ({ year, month, day }: CalendarDate) => Date.UTC(year, month - 1, day) / 86_400_000;

// `group_overlapping_intervals`: the intervals arrive ordered by start, then end; one that touches the previous group joins it.
function groupOverlapping(sorted: Interval[]): Interval[] {
  const grouped: Interval[] = [];
  for (const interval of sorted) {
    const last = grouped.at(-1);
    if (last === undefined || interval.start > last.end) grouped.push({ ...interval });
    else last.end = Math.max(last.end, interval.end);
  }
  return grouped;
}

const byStartThenEnd = (a: Interval, b: Interval) => a.start - b.start || a.end - b.end;

// The availabilities minus the bookings, then pulled in by the notice period and by the days that already hold the daily maximum.
export function computeCallAvailabilities(input: ComputeInput): Interval[] {
  const { zone, now } = input;
  const dateOf = (instant: number) => calendarDateInTimeZone(zone, new Date(instant));
  const changes = new Map<number, number>();
  const bump = (time: number, by: number) => changes.set(time, (changes.get(time) ?? 0) + by);
  for (const interval of groupOverlapping([...input.availabilities].sort(byStartThenEnd))) {
    bump(interval.start, 1);
    bump(interval.end, -1);
  }
  for (const interval of groupOverlapping([...input.sellerBookings].sort(byStartThenEnd))) {
    bump(interval.start, -1);
    bump(interval.end, 1);
  }
  const untaken: Interval[] = [];
  let currentStart: number | null = null;
  let current = 0;
  for (const [time, change] of [...changes].sort((a, b) => a[0] - b[0])) {
    current += change;
    if (current > 0) currentStart ??= time;
    if (current <= 0 && currentStart !== null) {
      untaken.push({ start: currentStart, end: time });
      currentStart = null;
    }
  }

  const earliest = input.minimumNoticeInMinutes === null ? now : now + input.minimumNoticeInMinutes * MINUTE_MS;
  const maximum = input.maximumCallsPerDay ?? Infinity;
  const todayStart = startOfDayInstant(zone, dateOf(now)).getTime();
  const callsPerDay = new Map<string, number>();
  for (const start of input.productBookingStarts) {
    if (start < todayStart) continue;
    const key = dateKey(dateOf(start));
    callsPerDay.set(key, (callsPerDay.get(key) ?? 0) + 1);
  }
  const canTakeMore = (date: CalendarDate) => (callsPerDay.get(dateKey(date)) ?? 0) < maximum;

  const result: Interval[] = [];
  for (const interval of untaken) {
    if (interval.end < earliest) continue;
    if (interval.start < earliest) interval.start = earliest;

    if (!canTakeMore(dateOf(interval.start))) {
      const last = dayNumber(dateOf(interval.end));
      let day = addDays(dateOf(interval.start), 1);
      while (dayNumber(day) <= last && !canTakeMore(day)) day = addDays(day, 1);
      if (dayNumber(day) > last) continue;
      interval.start = startOfDayInstant(zone, day).getTime();
    }
    if (!canTakeMore(dateOf(interval.end))) {
      const first = dayNumber(dateOf(interval.start));
      let day = addDays(dateOf(interval.end), -1);
      while (dayNumber(day) >= first && !canTakeMore(day)) day = addDays(day, -1);
      if (dayNumber(day) < first) continue;
      interval.end = endOfDayInstant(zone, day).getTime();
    }
    result.push(interval);
  }
  return result;
}

type BookingRow = { start_time: Date; end_time: Date };

// `Call.occupies_availability` through `product.sold_calls` or `user.sold_calls`, limited to calls whose `since.column` is not before `since.at`.
async function bookedCalls(
  owner: { column: "link_id" | "seller_id"; id: bigint },
  since: { column: "end_time" | "start_time"; at: Date },
): Promise<BookingRow[]> {
  const flag = (name: Parameters<typeof PurchaseFlags.condition>[0]) => PurchaseFlags.condition(name, true);
  return selectRows<BookingRow>(
    Prisma.sql`SELECT ${column("calls", "start_time")}, ${column("calls", "end_time")} FROM ${table("calls")}
      INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("calls", "purchase_id")}
      LEFT OUTER JOIN ${table("subscriptions")} ON ${column("subscriptions", "id")} = ${column("purchases", "subscription_id")}
      WHERE ${column("purchases", owner.column)} = ${owner.id}
        AND ${column("calls", since.column)} >= ${since.at}
        AND ${column("purchases", "purchase_state")} IN (${Prisma.join(INVENTORY_PURCHASE_STATES)})
        AND (${column("purchases", "subscription_id")} IS NULL OR ${flag("is_original_subscription_purchase")} OR ${flag("is_gift_receiver_purchase")})
        AND ${PurchaseFlags.condition("is_additional_contribution", false)}
        AND ${PurchaseFlags.condition("is_archived_original_subscription_purchase", false)}
        AND ${column("subscriptions", "deactivated_at")} IS NULL
        AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0)`,
  );
}

const toInterval = (row: BookingRow): Interval => ({ start: row.start_time.getTime(), end: row.end_time.getTime() });

async function index(_action: ActionContext, routeParams: Record<string, string>): Promise<ActionResult> {
  const permalink = routeParams.product_id ?? "";
  // `Link.find_by(unique_permalink:)`: a deleted product answers too.
  const [product] =
    permalink === ""
      ? []
      : await selectRows<{ id: bigint; user_id: bigint | null; native_type: string | null }>(
          Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "native_type")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
        );
  if (product === undefined) throw new RoutingError("Not Found");
  // `head :not_found`
  if (product.native_type !== NATIVE_TYPE_CALL)
    return { status: 404, body: "", contentType: "application/json", paramsRead: true };
  if (product.user_id === null) throw new HandBackToRails("a call product without a seller");

  const [user] = await selectRows<{ timezone: string | null }>(
    Prisma.sql`SELECT ${column("users", "timezone")} FROM ${table("users")} WHERE ${column("users", "id")} = ${product.user_id} LIMIT 1`,
  );
  if (user === undefined) throw new HandBackToRails("a call product whose seller is missing");
  // `Time.use_zone(nil)` leaves the application's zone, UTC.
  const zone = user.timezone ?? "UTC";
  if (!isKnownTimeZone(zone)) throw new HandBackToRails("a seller time zone outside ActiveSupport's list");
  const [limits] = await selectRows<{ minimum_notice_in_minutes: number | null; maximum_calls_per_day: number | null }>(
    Prisma.sql`SELECT ${column("call_limitation_infos", "minimum_notice_in_minutes")}, ${column("call_limitation_infos", "maximum_calls_per_day")} FROM ${table("call_limitation_infos")} WHERE ${column("call_limitation_infos", "call_id")} = ${product.id} LIMIT 1`,
  );
  // Rails raises on the missing record.
  if (limits === undefined) throw new HandBackToRails("a call product without limitation info");

  const now = new Date();
  const availabilities = await selectRows<BookingRow>(
    Prisma.sql`SELECT ${column("call_availabilities", "start_time")}, ${column("call_availabilities", "end_time")} FROM ${table("call_availabilities")} WHERE ${column("call_availabilities", "call_id")} = ${product.id} AND ${column("call_availabilities", "end_time")} >= ${now}`,
  );
  const sellerBookings = await bookedCalls(
    { column: "seller_id", id: product.user_id },
    { column: "end_time", at: now },
  );
  const productBookings = await bookedCalls(
    { column: "link_id", id: product.id },
    { column: "start_time", at: startOfDayInstant(zone, calendarDateInTimeZone(zone, now)) },
  );

  const intervals = computeCallAvailabilities({
    zone,
    now: now.getTime(),
    availabilities: availabilities.map(toInterval),
    sellerBookings: sellerBookings.map(toInterval),
    productBookingStarts: productBookings.map((row) => row.start_time.getTime()),
    minimumNoticeInMinutes: limits.minimum_notice_in_minutes,
    maximumCallsPerDay: limits.maximum_calls_per_day,
  });
  return json({
    call_availabilities: intervals.map((interval) => ({
      start_time: instantInTimeZoneIso8601(zone, new Date(interval.start)),
      end_time: instantInTimeZoneIso8601(zone, new Date(interval.end)),
    })),
  });
}

export const remainingCallAvailabilitiesResponse = (
  incoming: Request,
  params: Promise<Record<string, string>>,
): Promise<Response> =>
  params.then((routeParams) => processAction(incoming, {}, (action) => index(action, routeParams)));
