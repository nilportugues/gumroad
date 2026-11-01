// Calendar dates and their midnights in a user's time zone, as ActiveSupport computes them for
// CreatorAnalytics::DateQuery and D3. A civil date is "YYYY-MM-DD".
import SIGNED_IN_DATA from "../page-props/signed-in/signed-in-data.generated.json" with { type: "json" };

const TIME_ZONES = new Map(Object.entries(SIGNED_IN_DATA.timeZones as Record<string, string>));
const DAY_MS = 86_400_000;

export class TimeZoneNotPortedError extends Error {
  constructor(what: string) {
    super(`${what} is not ported to Next.js yet`);
    this.name = "NotPortedError";
  }
}

// User#timezone_id: ActiveSupport::TimeZone::MAPPING.fetch(timezone)
export function timezoneId(timezone: string | null): string {
  const id = TIME_ZONES.get(timezone ?? "");
  if (!id) throw new TimeZoneNotPortedError(`the time zone ${JSON.stringify(timezone)}`);
  return id;
}

const civilToMs = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day);
};
const msToCivil = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => msToCivil(civilToMs(date) + days * DAY_MS);

// UTC offset in minutes of an IANA zone at an instant.
function offsetMinutesAt(instantMs: number, iana: string): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: iana, timeZoneName: "longOffset" }).formatToParts(new Date(instantMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/u.exec(part);
  return match?.[1] ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

const formatOffset = (minutes: number): string => {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.trunc(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};

// date.in_time_zone(zone).iso8601: the first instant of the date in the zone. TimeWithZone prints "Z"
// only for the UTC zone. A midnight that does not exist or happens twice (a DST change at 00:00) is
// refused rather than guessed.
export function dayStartIso(date: string, iana: string): string {
  const wallMs = civilToMs(date);
  const candidates = new Set([offsetMinutesAt(wallMs - DAY_MS, iana), offsetMinutesAt(wallMs + DAY_MS, iana)]);
  const valid = [...candidates].filter((offset) => offsetMinutesAt(wallMs - offset * 60_000, iana) === offset);
  if (valid.length !== 1) throw new TimeZoneNotPortedError(`midnight of ${date} in ${iana} (a DST change at midnight)`);
  const offset = valid[0]!;
  return `${date}T00:00:00${iana === "Etc/UTC" ? "Z" : formatOffset(offset)}`;
}

// instant.in_time_zone(zone).to_date
export function civilDateInZone(instantMs: number, iana: string): string {
  return msToCivil(instantMs + offsetMinutesAt(instantMs, iana) * 60_000);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const parts = (date: string) => {
  const ms = civilToMs(date);
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay() };
};

// Integer#ordinalize
export function ordinalize(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

// D3.date_domain
export function dateDomain(dates: string[]): string[] {
  return dates.map((_, index) => {
    const { month, day, weekday } = parts(addDays(dates[0]!, index));
    return `${WEEKDAYS[weekday]}, ${MONTHS[month]} ${ordinalize(day)}`;
  });
}

// D3.formatted_date: strftime("%b %e, %Y") pads the day with a space.
export function formattedDate(date: string, todayDate: string): string {
  if (date === todayDate) return "Today";
  const { year, month, day } = parts(date);
  return `${MONTHS[month]!.slice(0, 3)} ${String(day).padStart(2, " ")}, ${year}`;
}
