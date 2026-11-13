import type { Json } from "./canonical";
import type { Fixture } from "./fixture";

// A page that formats dates ("March 7th, 2026") from rows seeded relative to the replay's clock shows a different
// day than the one recorded. These helpers move the recorded strings by the days between the recording and the
// replay, which is exact for dates that are a whole number of days before or after the day of the request.
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const ORDINAL_DATE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(st|nd|rd|th), (\d{4})\b/gu;
const DAY_MS = 86_400_000;
// "2026-11-09" and "Nov 9, 2026" are the other shapes a page prints a day relative to the request in. A constant a spec
// pins (the 2099 schedule, a card's expiry) lies far from the recording day and is left alone.
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;
const SHORT_DATE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( ?\d{1,2}), (\d{4})\b/gu;
// "Wednesday, November 4th": strftime-style chart labels carry no year, so the recording's year is assumed.
// strftime "%B %e, %Y" pads a single-digit day with a space ("November  9, 2026").
const LONG_DATE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December) ( ?\d{1,2}), (\d{4})\b/gu;
const WEEKDAY_DATE =
  /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(st|nd|rd|th)\b/gu;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));
const DRIFT_WINDOW_DAYS = 400;

const ordinalize = (day: number) => {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
};

export const daysBetween = (from: string, to: Date) =>
  Math.round(
    (Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );

const withinWindow = (shifted: Date, from: Date) =>
  Math.abs(shifted.getTime() - from.getTime()) <= DRIFT_WINDOW_DAYS * DAY_MS;

export function shiftOrdinalDates(value: Json, days: number, recordedOn?: string): Json {
  if (typeof value === "string") {
    const anchor = recordedOn === undefined ? null : new Date(`${recordedOn}T00:00:00Z`);
    const shiftIso = (text: string) =>
      anchor === null
        ? text
        : text
            .replace(ISO_DATE, (match, year: string, month: string, day: string) => {
              const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
              if (Number.isNaN(at.getTime()) || !withinWindow(at, anchor)) return match;
              return new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);
            })
            .replace(SHORT_DATE, (match, month: string, day: string, year: string) => {
              const at = new Date(Date.UTC(Number(year), SHORT_MONTHS.indexOf(month), Number(day)));
              if (!withinWindow(at, anchor)) return match;
              const moved = new Date(at.getTime() + days * DAY_MS);
              const padded = day.startsWith(" ")
                ? String(moved.getUTCDate()).padStart(2, " ")
                : String(moved.getUTCDate());
              return `${SHORT_MONTHS[moved.getUTCMonth()]} ${padded}, ${moved.getUTCFullYear()}`;
            })
            .replace(WEEKDAY_DATE, (match, _weekday: string, month: string, day: string) => {
              const at = new Date(Date.UTC(anchor.getUTCFullYear(), MONTHS.indexOf(month), Number(day)));
              if (!withinWindow(at, anchor)) return match;
              const moved = new Date(at.getTime() + days * DAY_MS);
              return `${WEEKDAYS[moved.getUTCDay()]}, ${MONTHS[moved.getUTCMonth()]} ${ordinalize(moved.getUTCDate())}`;
            });
    return shiftIso(value)
      .replace(ORDINAL_DATE, (match, month: string, day: string, _suffix, year: string) => {
        const at = new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day)));
        if (anchor !== null && !withinWindow(at, anchor)) return match;
        const shifted = new Date(at.getTime() + days * DAY_MS);
        return `${MONTHS[shifted.getUTCMonth()]} ${ordinalize(shifted.getUTCDate())}, ${shifted.getUTCFullYear()}`;
      })
      .replace(LONG_DATE, (match, month: string, day: string, year: string) => {
        const at = new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day)));
        if (anchor !== null && !withinWindow(at, anchor)) return match;
        const moved = new Date(at.getTime() + days * DAY_MS);
        const shown = day.startsWith(" ") ? String(moved.getUTCDate()).padStart(2, " ") : String(moved.getUTCDate());
        return `${MONTHS[moved.getUTCMonth()]} ${shown}, ${moved.getUTCFullYear()}`;
      });
  }
  if (Array.isArray(value)) return value.map((item) => shiftOrdinalDates(item, days, recordedOn));
  if (value !== null && typeof value === "object") return shiftObject(value as Record<string, Json>, days, recordedOn);
  return value;
}

// Dates the application pins in code, not computed from the request's day.
const CONSTANT_KEYS = new Set(["confirmations_version"]);
const ISO_KEY = /^\d{4}-\d{2}-\d{2}$/u;
// A date column is recorded as a token relative to the recording day, so even a constant the spec pins (a 1975
// birthday) is seeded a day later on the next day and its response moves with it, however far from today.
const SEEDED_DATE_KEYS = new Set(["date_of_birth", "birthday"]);

const shiftSeededDate = (text: string, days: number) =>
  ISO_KEY.test(text) ? new Date(Date.parse(`${text}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10) : text;

function shiftObject(value: Record<string, Json>, days: number, recordedOn?: string): Json {
  const moved: Record<string, Json> = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      // Charts key a row per day ("2026-11-04").
      ISO_KEY.test(key) ? (shiftOrdinalDates(key, days, recordedOn) as string) : key,
      SEEDED_DATE_KEYS.has(key) && typeof item === "string" && recordedOn !== undefined
        ? shiftSeededDate(item, days)
        : CONSTANT_KEYS.has(key)
          ? item
          : shiftOrdinalDates(item, days, recordedOn),
    ]),
  );
  // A date of birth is stored as three integers, seeded relative to the day of the request.
  const { dob_year: year, dob_month: month, dob_day: day } = moved;
  if (
    recordedOn !== undefined &&
    typeof year === "number" &&
    year > 0 &&
    typeof month === "number" &&
    month > 0 &&
    typeof day === "number"
  ) {
    const at = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
    return { ...moved, dob_year: at.getUTCFullYear(), dob_month: at.getUTCMonth() + 1, dob_day: at.getUTCDate() };
  }
  return moved;
}

// The fixture with the inertia props (and the JSON of an X-Inertia visit) of one exchange moved to today.
// `also` names the parts a spec's date lands in besides the props: rows the application stamps with its own day, or a plain-text
// body. Only spelled-out dates move there: an ISO date in a row is as likely a constant the app pins (a statement version).
export function withDriftedDates(
  fixture: Fixture,
  index: number,
  now = new Date(),
  also: readonly ("db" | "body")[] = [],
): Fixture {
  if (!fixture.recordedOn) return fixture;
  const days = daysBetween(fixture.recordedOn, now);
  const exchanges = fixture.exchanges.map((exchange, i) => {
    if (i !== index) return exchange;
    const { response } = exchange;
    return {
      ...exchange,
      ...(exchange.jobs === undefined
        ? {}
        : {
            jobs: shiftOrdinalDates(
              exchange.jobs as unknown as Json,
              days,
              fixture.recordedOn,
            ) as unknown as typeof exchange.jobs,
          }),
      ...(also.includes("db")
        ? { db: shiftOrdinalDates(exchange.db as unknown as Json, days) as unknown as typeof exchange.db }
        : {}),
      response: {
        ...response,
        ...(also.includes("body") && response.body !== undefined
          ? { body: shiftOrdinalDates(response.body, days) as string }
          : {}),
        ...(response.inertia === undefined
          ? {}
          : { inertia: shiftOrdinalDates(response.inertia, days, fixture.recordedOn) }),
        ...(response.json === undefined ? {} : { json: shiftOrdinalDates(response.json, days, fixture.recordedOn) }),
      },
    };
  });
  return { ...fixture, exchanges };
}

const HOUR_MS = 3_600_000;
const INSTANT = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})/gu;

// A request that names an instant literally (2099-01-01T10:00:00Z) is recorded against a response that masks it as hours
// from the recording (`<now+632328h>`), and the replay masks the port's output against its own clock. Moving each literal by
// the whole hours since the recording keeps the distance from "now" the recording had, so the tokens line up at any hour.
// `recordedAt` is the middle of what the hour-rounded tokens allow; the shift rounds so the remainder stays inside half an hour.
export function shiftLiteralInstants(body: string, recordedAt: Date, now: Date): string {
  const hours = Math.ceil((now.getTime() - recordedAt.getTime()) / HOUR_MS - 0.5);
  return body.replace(INSTANT, (_match, local: string, zone: string) => {
    const offsetMs =
      zone === "Z"
        ? 0
        : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * 60_000;
    const shifted = new Date(Date.parse(`${local}${zone}`) + hours * HOUR_MS + offsetMs);
    const fraction = /\.\d+$/u.exec(local)?.[0] ?? "";
    return `${shifted.toISOString().slice(0, 19)}${fraction}${zone}`;
  });
}
