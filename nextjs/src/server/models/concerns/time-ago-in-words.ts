// ActionView::Helpers::DateHelper#distance_of_time_in_words (include_seconds: false), which `time_ago_in_words` calls with
// to_time = Time.now. Golden: __fixtures__/time-ago-in-words.golden.json (scripts/golden/time-ago-in-words.rb).
const MINUTES_IN_YEAR = 525_600;
const MINUTES_IN_QUARTER_YEAR = 131_400;
const MINUTES_IN_THREE_QUARTERS_YEAR = 394_200;
const MINUTE_MS = 60_000;

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

// Ruby's Float#round (half away from zero) of a non-negative number.
const round = (value: number) => Math.floor(value + 0.5);

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

export function distanceOfTimeInWords(from: Date, to: Date): string {
  const [earlier, later] = from.getTime() <= to.getTime() ? [from, to] : [to, from];
  const distanceInMinutes = round((later.getTime() - earlier.getTime()) / MINUTE_MS);

  if (distanceInMinutes <= 1) return distanceInMinutes === 0 ? "less than a minute" : "1 minute";
  if (distanceInMinutes < 45) return plural(distanceInMinutes, "minute");
  if (distanceInMinutes < 90) return "about 1 hour";
  if (distanceInMinutes < 1440) return `about ${plural(round(distanceInMinutes / 60), "hour")}`;
  if (distanceInMinutes < 2520) return "1 day";
  if (distanceInMinutes < 43_200) return plural(round(distanceInMinutes / 1440), "day");
  if (distanceInMinutes < 86_400) return `about ${plural(round(distanceInMinutes / 43_200), "month")}`;
  if (distanceInMinutes < 525_600) return plural(round(distanceInMinutes / 43_200), "month");

  const fromYear = earlier.getUTCFullYear() + (earlier.getUTCMonth() + 1 >= 3 ? 1 : 0);
  const toYear = later.getUTCFullYear() - (later.getUTCMonth() + 1 < 3 ? 1 : 0);
  let leapYears = 0;
  for (let year = fromYear; year <= toYear; year++) if (isLeap(year)) leapYears++;
  const minutesWithOffset = distanceInMinutes - leapYears * 1440;
  const remainder = minutesWithOffset % MINUTES_IN_YEAR;
  const years = Math.floor(minutesWithOffset / MINUTES_IN_YEAR);
  if (remainder < MINUTES_IN_QUARTER_YEAR) return `about ${plural(years, "year")}`;
  if (remainder < MINUTES_IN_THREE_QUARTERS_YEAR) return `over ${plural(years, "year")}`;
  return `almost ${plural(years + 1, "year")}`;
}

export const timeAgoInWords = (from: Date, now: Date = new Date()) => distanceOfTimeInWords(from, now);
