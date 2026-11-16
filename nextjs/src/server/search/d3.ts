// D3 (lib/utilities/d3.rb): the date labels the analytics charts are drawn with. Dates are civil dates
// ("YYYY-MM-DD"); hourly buckets are instants read in the seller's zone.
import { addDays, civilDateInZone, dateDomain, formattedDate, ordinalize } from "./civil-time.ts";

export type DateAndMonth = { date: string; month: string; month_index: number };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// D3.date_month_domain over `dates.first + i` for each date: consecutive days.
export function dateMonthDomain(dates: string[]): DateAndMonth[] {
  let lastMonth: string | null = null;
  let monthIndex = -1;
  const labels = dateDomain(dates);
  return dates.map((_, index) => {
    const date = addDays(dates[0]!, index);
    const month = `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    if (month !== lastMonth) {
      lastMonth = month;
      monthIndex += 1;
    }
    return { date: labels[index]!, month, month_index: monthIndex };
  });
}

type LocalParts = { year: string; month: number; day: number; hour: number; minute: number; weekday: number };

// The wall-clock fields of an instant in a zone.
export function localParts(epochMs: number, iana: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: iana, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(epochMs));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return { year: part("year"), month: Number(part("month")), day: Number(part("day")), hour: Number(part("hour")), minute: Number(part("minute")), weekday: new Date(`${date}T00:00:00Z`).getUTCDay() };
}

// Time#strftime("%Y-%m-%dT%H:%M")
export function hourKeyOf(epochMs: number, iana: string): string {
  const { year, month, day, hour, minute } = localParts(epochMs, iana);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

// D3.hour_month_domain: the first instant of each bucket, labelled with its wall-clock hour,
// e.g. "Thursday, July 16th, 1 PM".
export function hourMonthDomain(instantsMs: number[], iana: string): DateAndMonth[] {
  let lastMonth: string | null = null;
  let monthIndex = -1;
  return instantsMs.map((instant) => {
    const local = localParts(instant, iana);
    const month = `${MONTHS[local.month - 1]} ${local.year}`;
    if (month !== lastMonth) {
      lastMonth = month;
      monthIndex += 1;
    }
    // strftime("%l %p").strip
    const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
    return { date: `${WEEKDAYS[local.weekday]}, ${MONTHS[local.month - 1]} ${ordinalize(local.day)}, ${hour12} ${local.hour < 12 ? "AM" : "PM"}`, month, month_index: monthIndex };
  });
}

// D3.formatted_date_with_timezone(time, timezone): "Today" is read in the seller's zone.
export function formattedDateWithTimezone(time: Date, iana: string, now: Date = new Date()): string {
  return formattedDate(civilDateInZone(time.getTime(), iana), civilDateInZone(now.getTime(), iana));
}
