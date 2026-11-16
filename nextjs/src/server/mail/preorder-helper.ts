// PreorderHelper#displayable_release_at_date_and_time (app/helpers/preorder_helper.rb): the release time in the
// seller's zone, as "December 25th,  9AM PST". `%l` pads the hour with a space, so a single-digit hour leaves two.
import { isKnownTimeZone, utcOffsetAt } from "../models/concerns/rails-time-zone.ts";

import { MailViewNotPortedError } from "./views.ts";

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

const HOUR_SECONDS = 3600;
// The zones whose `%Z` is a fixed pair of letters: [standard offset in hours, standard abbreviation, daylight abbreviation].
// Every other zone abbreviates through tzdata (IST, JST, "+03"), which is not ported.
const ABBREVIATIONS: Record<string, [number, string, string]> = {
  "Pacific Time (US & Canada)": [-8, "PST", "PDT"],
  "Mountain Time (US & Canada)": [-7, "MST", "MDT"],
  "Central Time (US & Canada)": [-6, "CST", "CDT"],
  "Eastern Time (US & Canada)": [-5, "EST", "EDT"],
  UTC: [0, "UTC", "UTC"],
};

// Integer#ordinalize
function ordinalize(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10 > 3 ? 0 : day % 10]}`;
}

export function displayableReleaseAtDateAndTime(releaseAt: Date, zoneName: string | null): string {
  if (zoneName === null || !isKnownTimeZone(zoneName) || !(zoneName in ABBREVIATIONS))
    throw new MailViewNotPortedError(`release time in the seller's zone ${String(zoneName)}`);
  const [standardHours, standard, daylight] = ABBREVIATIONS[zoneName]!;
  const offset = utcOffsetAt(zoneName, releaseAt.getTime());
  const abbreviation =
    offset === standardHours * HOUR_SECONDS
      ? standard
      : offset === (standardHours + 1) * HOUR_SECONDS
        ? daylight
        : null;
  if (abbreviation === null) throw new MailViewNotPortedError(`offset of ${zoneName}`);

  const local = new Date(releaseAt.getTime() + offset * 1000);
  const hour = local.getUTCHours() % 12 === 0 ? 12 : local.getUTCHours() % 12;
  const minute = local.getUTCMinutes();
  const meridiem = local.getUTCHours() < 12 ? "AM" : "PM";
  const time = `${String(hour).padStart(2, " ")}${minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`}${meridiem}`;
  return `${MONTHS[local.getUTCMonth()]} ${ordinalize(local.getUTCDate())}, ${time} ${abbreviation}`;
}
