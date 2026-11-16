// `Time.iso8601` (Time.xmlschema) for the datetime form: the date-only form Ruby's regexp offers is refused by the version in
// production, and a time without a zone is read in the server's zone, which is UTC. Shapes whose error depends on which Time.utc
// check trips first are not reproduced: they throw NotPortedError, which a job turns into a hand-back before it writes.
import { MicroDate } from "./ruby-time.ts";

// Ruby's `\s` is ASCII whitespace; JavaScript's matches more.
const XMLSCHEMA =
  /^[ \t\n\v\f\r]*(-?\d+)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?(Z|[+-]\d\d(?::?\d\d)?)?[ \t\n\v\f\r]*$/iu;
const MAX_UTC_OFFSET_HOURS = 24;
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;
const MAX_DAY_OF_MONTH = 31;
const MAX_SECOND = 60;
const MICROSECOND_DIGITS = 6;

export class RubyArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

class NotPortedTimeError extends Error {
  constructor(reason: string) {
    super(`Time.iso8601: ${reason}`);
    this.name = "NotPortedError";
  }
}

function offsetSeconds(zone: string | undefined): number {
  if (zone === undefined || zone.toUpperCase() === "Z") return 0;
  const match = /^([+-])(\d\d)(?::?(\d\d))?$/u.exec(zone)!;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours >= MAX_UTC_OFFSET_HOURS) throw new RubyArgumentError("utc_offset out of range");
  if (minutes > 59) throw new NotPortedTimeError("an offset with 60 or more minutes");
  return (match[1] === "-" ? -1 : 1) * (hours * 3600 + minutes * 60);
}

export function timeIso8601(text: string): MicroDate {
  const match = XMLSCHEMA.exec(text);
  if (match === null) throw new RubyArgumentError(`invalid xmlschema format: ${JSON.stringify(text)}`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fraction = (match[7] ?? ".").slice(1).padEnd(MICROSECOND_DIGITS, "0").slice(0, MICROSECOND_DIGITS);

  if (year < MIN_YEAR || year > MAX_YEAR) throw new NotPortedTimeError("a year outside 1000..9999");
  const invalid: string[] = [];
  if (month < 1 || month > 12) invalid.push("mon out of range");
  if (day === 0) invalid.push("mday out of range");
  else if (day > MAX_DAY_OF_MONTH) invalid.push("argument out of range");
  if (minute > 59) invalid.push("min out of range");
  if (second > MAX_SECOND) invalid.push("sec out of range");
  if (hour > 24 || (hour === 24 && (minute !== 0 || second !== 0))) invalid.push("hour out of range");
  let offset: number;
  try {
    offset = offsetSeconds(match[8]);
  } catch (error) {
    // Which of the offset and the date Ruby rejects first is not pinned down when both are wrong.
    if (invalid.length > 0) throw new NotPortedTimeError("an offset and a date component both out of range");
    throw error;
  }
  if (invalid.length === 1 && invalid[0] !== "hour out of range") throw new RubyArgumentError(invalid[0]!);
  if (invalid.length > 0) throw new NotPortedTimeError("several out of range components");

  const utcSeconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1000 - offset;
  return new MicroDate(utcSeconds, Number(fraction));
}
