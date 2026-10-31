// ActiveSupport duration arithmetic in UTC (config.time_zone is unset), for `n.months.ago` and
// friends. Calendar units clamp the day to the target month's end, as Time#advance does.
const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;

export type Duration = { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number; seconds?: number };

// Time#advance: years and months first (clamping the day), then weeks and days, then the clock.
export function advance(time: Date, duration: Duration): Date {
  const months = (duration.years ?? 0) * 12 + (duration.months ?? 0);
  let result = new Date(time.getTime());
  if (months !== 0) {
    const year = result.getUTCFullYear();
    const monthIndex = result.getUTCMonth() + months;
    const targetYear = year + Math.floor(monthIndex / 12);
    const targetMonth = ((monthIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(result.getUTCDate(), lastDay);
    result = new Date(
      Date.UTC(targetYear, targetMonth, day, result.getUTCHours(), result.getUTCMinutes(), result.getUTCSeconds(), result.getUTCMilliseconds()),
    );
  }
  const days = (duration.weeks ?? 0) * 7 + (duration.days ?? 0);
  const seconds = (duration.hours ?? 0) * 3600 + (duration.minutes ?? 0) * 60 + (duration.seconds ?? 0);
  return new Date(result.getTime() + days * MS_PER_DAY + seconds * MS_PER_SECOND);
}

// `duration.ago` (from `now`).
export function ago(duration: Duration, now: Date): Date {
  const negated = Object.fromEntries(Object.entries(duration).map(([k, v]) => [k, -(v as number)])) as Duration;
  return advance(now, negated);
}

// A UTC calendar date, as Ruby's Date (no time of day).
export type CalendarDate = { year: number; month: number; day: number };

export function toCalendarDate(time: Date): CalendarDate {
  return { year: time.getUTCFullYear(), month: time.getUTCMonth() + 1, day: time.getUTCDate() };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return toCalendarDate(new Date(Date.UTC(date.year, date.month - 1, date.day) + days * MS_PER_DAY));
}

// Date#to_s.
export function dateToS(date: CalendarDate): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

// Date#wday (Sunday is 0).
export function wday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

// A Date that carries microseconds. Prisma serializes Date values, typed or raw, with
// toISOString(), so this one reaches MySQL's datetime(6) columns exactly as ActiveRecord writes
// them; getTime() and comparisons still see whole milliseconds.
export class MicroDate extends Date {
  readonly microseconds: number;

  // `microseconds` is the fraction of the second, 0..999_999.
  constructor(secondsSinceEpoch: number, microseconds: number) {
    super(secondsSinceEpoch * 1000 + Math.floor(microseconds / 1000));
    this.microseconds = microseconds;
  }

  override toISOString(): string {
    return `${super.toISOString().slice(0, 19)}.${String(this.microseconds).padStart(6, "0")}Z`;
  }

  override toJSON(): string {
    return this.toISOString();
  }
}

const startOfDaySeconds = (date: CalendarDate) => Date.UTC(date.year, date.month - 1, date.day) / 1000;

// Date#beginning_of_day
export function beginningOfDay(date: CalendarDate): MicroDate {
  return new MicroDate(startOfDaySeconds(date), 0);
}

// Date#end_of_day: 23:59:59.999999999, which a datetime(6) column stores as .999999.
export function endOfDay(date: CalendarDate): MicroDate {
  return new MicroDate(startOfDaySeconds(date) + 86_399, 999_999);
}

// Date.parse for the ISO dates (Date#to_s) callers pass; other formats Date.parse accepts are refused.
export function parseIsoDate(text: string): CalendarDate {
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/u.exec(text);
  if (!match) throw new Error("invalid date");
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = toCalendarDate(new Date(Date.UTC(date.year, date.month - 1, date.day)));
  if (check.month !== date.month || check.day !== date.day) throw new Error("invalid date");
  return date;
}
