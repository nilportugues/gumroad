// ActiveSupport time zones for the one conversion the audience filters make: a calendar date, read as the start or the end
// of that day in a seller's zone (`Date#in_time_zone(zone)` and `.end_of_day`), written as ISO 8601.
// The zone names are ActiveSupport::TimeZone's; time-zones.generated.json (scripts/golden/audience-member-filter.rb) maps
// each to its tz database identifier, and Intl supplies the offsets. Golden: every zone on 11 dates, DST gaps included.
import zones from "./time-zones.generated.json" with { type: "json" };

const SECOND_MS = 1000;
const DAY_SECONDS = 86_400;
const END_OF_DAY_SECONDS = DAY_SECONDS - 1;

export class InvalidTimeZoneError extends Error {
  constructor(name: string) {
    super(`Invalid Timezone: ${name}`);
    this.name = "ArgumentError";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

// The zone's offset from UTC at an instant, in seconds.
function offsetAt(identifier: string, instantMs: number): number {
  let format = formatters.get(identifier);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: identifier, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(identifier, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instantMs)).map((part) => [part.type, Number(part.value)])) as Record<string, number>;
  const local = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((local - Math.floor(instantMs / SECOND_MS) * SECOND_MS) / SECOND_MS);
}

const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");

function isoOffset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const total = Math.abs(seconds);
  return `${sign}${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}`;
}

// `Date.new(year, month, day).in_time_zone(zone)` (`secondsIntoDay` 0), or `.end_of_day` (86399), as `iso8601`.
// A local time inside a DST gap moves forward by the gap, as TimeWithZone does; an ambiguous one takes the earlier instant.
export function dateInTimeZoneIso8601(zoneName: string, year: number, month: number, day: number, secondsIntoDay: number): string {
  const identifier = (zones as Record<string, string>)[zoneName];
  if (identifier === undefined) throw new InvalidTimeZoneError(zoneName);
  const localSeconds = Date.UTC(year, month - 1, day) / SECOND_MS + secondsIntoDay;
  const around = [offsetAt(identifier, (localSeconds - DAY_SECONDS) * SECOND_MS), offsetAt(identifier, (localSeconds + DAY_SECONDS) * SECOND_MS)];
  const candidates = [...new Set(around)].filter((offset) => offsetAt(identifier, (localSeconds - offset) * SECOND_MS) === offset);
  let offset: number;
  let shifted = localSeconds;
  if (candidates.length === 0) {
    // Skipped: the clock jumps from the earlier offset to the later one.
    offset = Math.max(...around);
    shifted = localSeconds + (offset - Math.min(...around));
  } else {
    offset = Math.max(...candidates);
  }
  const local = new Date(shifted * SECOND_MS);
  const stamp = `${String(local.getUTCFullYear()).padStart(4, "0")}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${stamp}${identifier === "Etc/UTC" ? "Z" : isoOffset(offset)}`;
}

// `instant.in_time_zone(zone).iso8601`
export function instantInTimeZoneIso8601(zoneName: string, instant: Date): string {
  const identifier = (zones as Record<string, string>)[zoneName];
  if (identifier === undefined) throw new InvalidTimeZoneError(zoneName);
  const offset = offsetAt(identifier, instant.getTime());
  const local = new Date(Math.floor(instant.getTime() / SECOND_MS) * SECOND_MS + offset * SECOND_MS);
  const stamp = `${String(local.getUTCFullYear()).padStart(4, "0")}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${stamp}${identifier === "Etc/UTC" ? "Z" : isoOffset(offset)}`;
}

export const startOfDayIso8601 =(zone: string, year: number, month: number, day: number) => dateInTimeZoneIso8601(zone, year, month, day, 0);
export const endOfDayIso8601 = (zone: string, year: number, month: number, day: number) => dateInTimeZoneIso8601(zone, year, month, day, END_OF_DAY_SECONDS);
