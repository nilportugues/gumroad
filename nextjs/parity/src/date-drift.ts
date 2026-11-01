import type { Fixture } from "./fixture";
import type { Json } from "./canonical";

// A page that formats dates ("March 7th, 2026") from rows seeded relative to the replay's clock shows a different
// day than the one recorded. These helpers move the recorded strings by the days between the recording and the
// replay, which is exact for dates that are a whole number of days before or after the day of the request.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ORDINAL_DATE = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(st|nd|rd|th), (\d{4})\b/g;
const DAY_MS = 86_400_000;

const ordinalize = (day: number) => {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
};

export const daysBetween = (from: string, to: Date) => Math.round((Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export function shiftOrdinalDates(value: Json, days: number): Json {
  if (typeof value === "string") {
    return value.replace(ORDINAL_DATE, (_match, month: string, day: string, _suffix, year: string) => {
      const shifted = new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day)) + days * DAY_MS);
      return `${MONTHS[shifted.getUTCMonth()]} ${ordinalize(shifted.getUTCDate())}, ${shifted.getUTCFullYear()}`;
    });
  }
  if (Array.isArray(value)) return value.map((item) => shiftOrdinalDates(item, days));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftOrdinalDates(item as Json, days)]));
  return value;
}

// The fixture with the inertia props (and the JSON of an X-Inertia visit) of one exchange moved to today.
export function withDriftedDates(fixture: Fixture, index: number, now = new Date()): Fixture {
  if (!fixture.recordedOn) return fixture;
  const days = daysBetween(fixture.recordedOn, now);
  const exchanges = fixture.exchanges.map((exchange, i) => {
    if (i !== index) return exchange;
    const { response } = exchange;
    return {
      ...exchange,
      response: {
        ...response,
        ...(response.inertia === undefined ? {} : { inertia: shiftOrdinalDates(response.inertia, days) }),
        ...(response.json === undefined ? {} : { json: shiftOrdinalDates(response.json, days) }),
      },
    };
  });
  return { ...fixture, exchanges };
}
