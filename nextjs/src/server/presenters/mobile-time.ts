// Port of config/initializers/time_formats.rb: Time::DATE_FORMATS[:long_formatted_datetime] = "%e %b %Y %l:%M %p", read in a Rails zone name.
import zones from "../models/concerns/time-zones.generated.json" with { type: "json" };
import { NotPortedError } from "../page-props/not-ported.ts";

const formatters = new Map<string, Intl.DateTimeFormat>();

export function longFormattedDatetime(time: Date, zoneName: string): string {
  const identifier = new Map<string, string>(Object.entries(zones)).get(zoneName);
  if (identifier === undefined) throw new NotPortedError(`the time zone ${zoneName}`);
  let format = formatters.get(identifier);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: identifier,
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(identifier, format);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    format.formatToParts(time).find((entry) => entry.type === type)?.value ?? "";
  const hour24 = Number(part("hour"));
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${part("day").padStart(2, " ")} ${part("month")} ${part("year")} ${String(hour12).padStart(2, " ")}:${part("minute")} ${hour24 < 12 ? "AM" : "PM"}`;
}
