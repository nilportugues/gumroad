// ActionView and I18n helpers the ported views call, with Rails' default `en` locale (the app
// adds no translations for these keys) in UTC, the app's time zone.
import { h } from "./views.ts";

export class ViewHelperNotPortedError extends Error {}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ABBR_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ABBR_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

// I18n.l(time, format: "...") with a format string: I18n swaps %a %A %b %B %p %P for the locale's
// words (%p upcased, %P downcased), then Time#strftime does the rest.
export function localizeTime(time: Date, format: string): string {
  return format.replace(/%(-?)([a-zA-Z%])/gu, (directive, flag: string, conversion: string) => {
    const hour = time.getUTCHours();
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    const numeric = (n: number) => (flag === "-" ? String(n) : pad(n));
    if (flag === "-" && !"dmHIMSe".includes(conversion)) throw new ViewHelperNotPortedError(`strftime ${directive}`);
    switch (conversion) {
      case "B":
        return MONTH_NAMES[time.getUTCMonth()]!;
      case "b":
        return ABBR_MONTH_NAMES[time.getUTCMonth()]!;
      case "A":
        return DAY_NAMES[time.getUTCDay()]!;
      case "a":
        return ABBR_DAY_NAMES[time.getUTCDay()]!;
      case "p":
        return hour < 12 ? "AM" : "PM";
      case "P":
        return hour < 12 ? "am" : "pm";
      case "Y":
        return String(time.getUTCFullYear());
      case "m":
        return numeric(time.getUTCMonth() + 1);
      case "d":
        return numeric(time.getUTCDate());
      case "e":
        return flag === "-" ? String(time.getUTCDate()) : String(time.getUTCDate()).padStart(2, " ");
      case "H":
        return numeric(hour);
      case "I":
        return numeric(hour12);
      case "M":
        return numeric(time.getUTCMinutes());
      case "S":
        return numeric(time.getUTCSeconds());
      case "%":
        return "%";
      default:
        throw new ViewHelperNotPortedError(`strftime ${directive}`);
    }
  });
}

// distance_of_time_in_words(from_time, to_time = 0) for a duration in seconds with the default
// options (include_seconds: false), in the en locale's datetime.distance_in_words.
export function distanceOfTimeInWords(seconds: number): string {
  const distanceInMinutes = Math.round(Math.abs(seconds) / 60);
  const plural = (n: number, one: string, other: string) => (n === 1 ? one : `${n} ${other}`);
  if (distanceInMinutes <= 1) return distanceInMinutes === 0 ? "less than a minute" : "1 minute";
  if (distanceInMinutes < 45) return `${distanceInMinutes} minutes`;
  if (distanceInMinutes < 90) return "about 1 hour";
  // 90 minutes up to 24 hours
  if (distanceInMinutes < 1440) return `about ${plural(Math.round(distanceInMinutes / 60), "1 hour", "hours")}`;
  throw new ViewHelperNotPortedError(`distance_of_time_in_words for ${distanceInMinutes} minutes`);
}

type LinkOptions = { class?: string; target?: string };

// link_to(name, url, class:, target:): the html options in the order given, then href, each
// escaped as tag_options does.
export function linkTo(name: string, url: string, options: LinkOptions = {}): string {
  const attributes = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${h(value)}"`)
    .join("");
  return `<a${attributes} href="${h(url)}">${h(name)}</a>`;
}
