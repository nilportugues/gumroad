// CreatorAnalytics::HourlySalesCurve: the share of a typical day's revenue a seller has booked by a given
// time of day, from the trailing 28 days of countable sales. Cached for six hours in Rails.cache.
import { Prisma, type User } from "@prisma/client";

import { PurchaseFlags } from "../../search/flags.ts";
import { railsCache } from "../../cache/rails-cache.ts";
import { type MarshalValue, RubyFloat, RubySymbol } from "../../cache/marshal.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { addDays, civilDateInZone, dayStartIso, timezoneId } from "../../search/civil-time.ts";

const TRAILING_DAYS = 28;
const MINIMUM_DAYS_WITH_SALES = 7;
const CACHE_EXPIRES_IN_SECONDS = 6 * 3600;
const HOURS = 24;

type Seller = Pick<User, "id" | "timezone">;

// The offset in seconds and the instant of the zone's midnight, from `date.in_time_zone(zone).iso8601`.
function midnightOf(date: string, iana: string): { instant: Date; offsetSeconds: number } {
  const iso = dayStartIso(date, iana);
  const zone = /(Z|[+-]\d{2}:\d{2})$/u.exec(iso)![1]!;
  const offsetSeconds = zone === "Z" ? 0 : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 3600 + Number(zone.slice(4, 6)) * 60);
  return { instant: new Date(iso), offsetSeconds };
}

// `seller.sales.counts_towards_volume` (successful, not fully refunded, not charged back unless reversed)
// from the trailing window, grouped by local day and hour.
async function compute(seller: Seller, now: Date): Promise<number[] | null> {
  const iana = timezoneId(seller.timezone);
  const today = civilDateInZone(now.getTime(), iana);
  const windowEnd = midnightOf(today, iana);
  const windowStart = midnightOf(addDays(today, -TRAILING_DAYS), iana);
  // A fixed offset: the zone's current one (a daylight saving change inside the window shifts part of the history by an hour).
  const shifted = Prisma.sql`DATE_ADD(${column("purchases", "created_at")}, INTERVAL ${Prisma.raw(String(windowEnd.offsetSeconds))} SECOND)`;

  const rows = await selectRows<{ day: unknown; hour: number | bigint; cents: number | bigint | string | null }>(
    Prisma.sql`SELECT DATE(${shifted}) AS day, HOUR(${shifted}) AS hour, SUM(${column("purchases", "price_cents")}) AS cents FROM ${table("purchases")}
      WHERE ${column("purchases", "seller_id")} = ${seller.id}
      AND ${column("purchases", "purchase_state")} = 'successful'
      AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0)
      AND (${column("purchases", "chargeback_date")} IS NULL OR (${column("purchases", "chargeback_date")} IS NOT NULL AND ${column("purchases", "flags")} & ${Prisma.raw(`${PurchaseFlags.bit("chargeback_reversed")}`)} != 0))
      AND ${column("purchases", "created_at")} >= ${windowStart.instant} AND ${column("purchases", "created_at")} < ${windowEnd.instant}
      GROUP BY DATE(${shifted}), HOUR(${shifted})`,
  );

  const daysWithSales = new Set(rows.filter((row) => Number(row.cents) > 0).map((row) => String(row.day))).size;
  if (daysWithSales < MINIMUM_DAYS_WITH_SALES) return null;

  const hourly = Array.from({ length: HOURS }, () => 0);
  for (const row of rows) {
    const hour = Number(row.hour);
    if (hour >= 0 && hour < HOURS) hourly[hour]! += Number(row.cents);
  }
  const total = hourly.reduce((sum, cents) => sum + cents, 0);
  if (!(total > 0)) return null;

  let running = 0;
  return hourly.map((cents) => (running += cents) / total);
}

const asNumbers = (curve: MarshalValue | undefined): number[] | null =>
  Array.isArray(curve) ? curve.map((value) => (value instanceof RubyFloat ? value.value : Number(value))) : null;

// Rails.cache.fetch("creator_analytics/hourly_sales_curve/v4/<id>/<zone>", expires_in: 6.hours) { { curve: compute } }[:curve]
export async function cumulativeFractions(seller: Seller, now: Date): Promise<number[] | null> {
  const key = `creator_analytics/hourly_sales_curve/v4/${seller.id}/${timezoneId(seller.timezone)}`;
  const entry = await railsCache().fetch(key, { expiresIn: CACHE_EXPIRES_IN_SECONDS }, async () => {
    const curve = await compute(seller, now);
    return new Map<MarshalValue, MarshalValue>([[new RubySymbol("curve"), curve === null ? null : curve.map((value) => new RubyFloat(value))]]);
  });
  const curve = entry instanceof Map ? entry.get(new RubySymbol("curve")) ?? [...entry.entries()].find(([k]) => k instanceof RubySymbol && k.name === "curve")?.[1] : undefined;
  return asNumbers(curve);
}

// The local hour and minute of `now` in the zone.
function localClock(now: Date, iana: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: iana, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)!.value);
  return { hour: part("hour"), minute: part("minute") };
}

// Cumulative share by `now`, interpolated linearly within the hour; null without enough history.
export function fractionAt(curve: number[], hour: number, minute: number): number {
  const previous = hour > 0 ? curve[hour - 1]! : 0;
  return previous + (curve[hour]! - previous) * (minute / 60.0);
}

export async function expectedFractionOfDay(seller: Seller, now: Date = new Date()): Promise<number | null> {
  const curve = await cumulativeFractions(seller, now);
  if (curve === null) return null;
  const { hour, minute } = localClock(now, timezoneId(seller.timezone));
  return fractionAt(curve, hour, minute);
}
