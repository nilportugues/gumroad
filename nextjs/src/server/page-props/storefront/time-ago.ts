// ActionView::Helpers::DateHelper#time_ago_in_words with the en locale and default options
// (include_seconds: false).
const MINUTES_IN_YEAR = 525_600;
const MINUTES_IN_QUARTER_YEAR = 131_400;
const MINUTES_IN_THREE_QUARTERS_YEAR = 394_200;
const MINUTES_IN_DAY = 1440;
const MINUTES_IN_MONTH = 43_200;

const plural = (count: number, one: string, many: (count: number) => string) => (count === 1 ? one : many(count));
const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function distanceOfTimeInWords(from: Date, to: Date): string {
  const seconds = Math.round(Math.abs(to.getTime() - from.getTime()) / 1000);
  const minutes = Math.round(seconds / 60);

  if (minutes <= 1) return minutes === 0 ? "less than a minute" : "1 minute";
  if (minutes < 45) return `${minutes} minutes`;
  if (minutes < 90) return "about 1 hour";
  if (minutes < MINUTES_IN_DAY) return `about ${Math.round(minutes / 60)} hours`;
  if (minutes < 2520) return "1 day";
  if (minutes < MINUTES_IN_MONTH) return `${Math.round(minutes / MINUTES_IN_DAY)} days`;
  if (minutes < 86_400) {
    const months = Math.round(minutes / MINUTES_IN_MONTH);
    return plural(months, "about 1 month", (count) => `about ${count} months`);
  }
  if (minutes < MINUTES_IN_YEAR) return `${Math.round(minutes / MINUTES_IN_MONTH)} months`;

  const earlier = from <= to ? from : to;
  const later = from <= to ? to : from;
  const fromYear = earlier.getUTCFullYear() + (earlier.getUTCMonth() + 1 >= 3 ? 1 : 0);
  const toYear = later.getUTCFullYear() - (later.getUTCMonth() + 1 < 3 ? 1 : 0);
  let leapYears = 0;
  for (let year = fromYear; year <= toYear; year++) if (isLeapYear(year)) leapYears++;
  const offset = minutes - leapYears * MINUTES_IN_DAY;
  const remainder = ((offset % MINUTES_IN_YEAR) + MINUTES_IN_YEAR) % MINUTES_IN_YEAR;
  const years = Math.floor(offset / MINUTES_IN_YEAR);
  const word = (count: number) => plural(count, "1 year", (n) => `${n} years`);
  if (remainder < MINUTES_IN_QUARTER_YEAR) return `about ${word(years)}`;
  if (remainder < MINUTES_IN_THREE_QUARTERS_YEAR) return `over ${word(years)}`;
  return `almost ${word(years + 1)}`;
}

export const timeAgoInWords = (from: Date, now = new Date()) => distanceOfTimeInWords(from, now);
