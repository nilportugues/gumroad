// AudienceController#index: the follower count and the chart behind /dashboard/audience.
import { Prisma, type User } from "@prisma/client";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { followingByDate } from "../../search/following.ts";
import { addDays, civilDateInZone } from "../../search/civil-time.ts";
import { rackParam, type QuerySource } from "../audience/support.ts";

const LAST_DAYS = 29;
const UTC = "Etc/UTC";

// `audience_members.where(follower: true).count`
export async function totalFollowerCount(seller: User): Promise<number> {
  const [row] = await selectRows<{ count: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("audience_members")} WHERE ${column("audience_members", "seller_id")} = ${seller.id} AND ${column("audience_members", "follower")} = TRUE`,
  );
  return Number(row?.count ?? 0);
}

// Anything `Date._parse` reads a day or month from without digits (abbreviations suffice).
const DATE_WORD = /sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/iu;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/u;

type Parsed = { date: string; instantMs: number };

// DateTime.parse for the shapes the date range picker sends. Ruby reads any string it can find a date in
// (`Date._parse`), and what it reads is not worth guessing: anything else is Rails' to answer.
function parseDateTime(value: string): Parsed | null {
  // No digit and no day or month name: `Date._parse` finds nothing and `DateTime.parse` raises.
  if (!/\d/u.test(value) && !DATE_WORD.test(value)) return null;
  const day = ISO_DATE.exec(value);
  const full = ISO_DATETIME.exec(value);
  const match = day ?? full;
  if (!match) throw new HandBackToRails();
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) throw new HandBackToRails();
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  if (day) return { date: iso, instantMs: probe.getTime() };
  const [hour, minute, second] = [Number(full![4]), Number(full![5]), Number(full![6])];
  if (hour > 23 || minute > 59 || second > 59) throw new HandBackToRails();
  const zone = full![7];
  const offsetMinutes = zone === undefined || zone === "Z" ? 0 : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return { date: iso, instantMs: Date.UTC(year, month - 1, date, hour, minute, second) - offsetMinutes * 60_000 };
}

export type DateRange = { startDate: string; endDate: string };

// AudienceController#set_time_range: `from` and `to` or, when either does not parse (or is missing), the
// last 30 days ending now, as UTC dates (config.time_zone is unset). An end before the start becomes the start.
export function audienceRange(query: QuerySource, now: Date = new Date()): DateRange {
  const from = rackParam(query, "from");
  const to = rackParam(query, "to");
  // `DateTime.parse(nil)` and `DateTime.parse(["..."])` raise TypeError, which the action rescues.
  if (typeof from === "string" && typeof to === "string") {
    const end = parseDateTime(to);
    const start = parseDateTime(from);
    if (!end || !start) return lastThirtyDays(now);
    const endDate = end.instantMs < start.instantMs ? start.date : end.date;
    // Mixed offsets can put the end's civil date before the start's, which Ruby turns into an empty range.
    if (endDate < start.date) throw new HandBackToRails();
    return { startDate: start.date, endDate };
  }
  return lastThirtyDays(now);
}

function lastThirtyDays(now: Date): DateRange {
  const today = civilDateInZone(now.getTime(), UTC);
  return { startDate: addDays(today, -LAST_DAYS), endDate: today };
}

export async function audienceData(seller: User, range: DateRange) {
  if ((await totalFollowerCount(seller)) === 0) return null;
  return await followingByDate(seller, range.startDate, range.endDate);
}
