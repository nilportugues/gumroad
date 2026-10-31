// Port of Psych::ScalarScanner#tokenize (psych 5.2.6, strict_integer: false): how a plain YAML
// scalar is typed on load, and therefore which strings Psych must quote on dump.
import { RubyFloat, RubySymbol } from "./ruby-values";

export type Token =
  | { kind: "string"; value: string }
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: bigint }
  | { kind: "float"; value: RubyFloat }
  | { kind: "symbol"; value: RubySymbol }
  // Psych would build a Time/Date; safe_load rejects both (only Symbol is permitted).
  | { kind: "time"; valid: boolean }
  | { kind: "date"; valid: boolean };

const TIME = /^-?\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|\s+)\d{1,2}:\d\d:\d\d(?:\.\d*)?(?:\s*(?:Z|[-+]\d{1,2}:?(?:\d\d)?))?$/u;
const FLOAT = /^(?:[-+]?([0-9][0-9_,]*)?\.[0-9]*([eE][-+][0-9]+)?)$/u;
const INTEGER_LEGACY = /^(?:[-+]?0b[_,]*[0-1][0-1_,]*|[-+]?0[_,]*[0-7][0-7_,]*|[-+]?(?:0|[1-9](?:[0-9]|,[0-9]|_[0-9])*)|[-+]?0x[_,]*[0-9a-fA-F][0-9a-fA-F_,]*)$/u;
// Ruby [[:alpha:]] is Unicode Alphabetic but \s is ASCII-only; `^` and `$` are line anchors.
const STRINGY = /^[^\d.:-]?[\p{Alphabetic}_ \t\r\n\f\v!@#$%^&*(){}<>|/\\~;=]+/mu;

const lineMatch = (re: RegExp, s: string) => new RegExp(re.source, re.flags.includes("m") ? re.flags : `${re.flags}m`).test(s);

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= days;
}

// Time.utc raises ArgumentError for out-of-range fields (it rolls Feb 30 over, so days only to 31).
function validTime(string: string): boolean {
  const m = /(-?\d{4})-(\d{1,2})-(\d{1,2})[ \tTt]+(\d+):(\d+):(\d+)/u.exec(string);
  if (!m) return false;
  const [mon, day, h, min, sec] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  return mon >= 1 && mon <= 12 && day >= 1 && day <= 31 && h <= 24 && min <= 59 && sec <= 60;
}

// Kernel#Integer on the cleaned string: 0b/0x/0 (octal) prefixes, sign.
function parseRubyInteger(raw: string): bigint {
  const s = raw.replaceAll(/[,_]/gu, "");
  const negative = s.startsWith("-");
  const body = s.replace(/^[-+]/u, "");
  let value: bigint;
  if (/^0b/iu.test(body)) value = BigInt(`0b${body.slice(2)}`);
  else if (/^0x/iu.test(body)) value = BigInt(`0x${body.slice(2)}`);
  else if (/^0\d/u.test(body)) value = BigInt(`0o${body.slice(1)}`);
  else value = BigInt(body);
  return negative ? -value : value;
}

export function tokenize(string: string): Token {
  if (string === "") return { kind: "null" };
  if (lineMatch(STRINGY, string) || string.includes("\n")) {
    if ([...string].length > 5) return { kind: "string", value: string };
    if (/^[^ytonf~]/imu.test(string)) return { kind: "string", value: string };
    if (string === "~" || /^null$/imu.test(string)) return { kind: "null" };
    if (/^(yes|true|on)$/imu.test(string)) return { kind: "bool", value: true };
    if (/^(no|false|off)$/imu.test(string)) return { kind: "bool", value: false };
    return { kind: "string", value: string };
  }
  if (lineMatch(TIME, string)) return { kind: "time", valid: validTime(string) };
  const date = /^(\d{4})-(1[012]|0\d|\d)-([12]\d|3[01]|0\d|\d)$/mu.exec(string);
  if (date) return { kind: "date", valid: validDate(Number(date[1]), Number(date[2]), Number(date[3])) };
  if (/^\+?\.inf$/imu.test(string)) return { kind: "float", value: new RubyFloat(Infinity) };
  if (/^-\.inf$/imu.test(string)) return { kind: "float", value: new RubyFloat(-Infinity) };
  if (/^\.nan$/imu.test(string)) return { kind: "float", value: new RubyFloat(NaN) };
  if (/^:./mu.test(string)) {
    const quoted = /^:(["'])(.*)\1/u.exec(string);
    return { kind: "symbol", value: new RubySymbol(quoted ? quoted[2]!.replace(/^:/u, "") : string.replace(/^:/u, "")) };
  }
  if (/^[-+]?[0-9][0-9_]*(:[0-5]?[0-9]){1,2}$/mu.test(string)) {
    // Sexagesimal integer, e.g. "1:20" is 80.
    const parts = string.split(":");
    let total = 0n;
    parts.forEach((n, e) => (total += BigInt(Number.parseInt(n.replaceAll("_", ""), 10) || 0) * 60n ** BigInt(Math.abs(e - 2))));
    return { kind: "int", value: total };
  }
  if (/^[-+]?[0-9][0-9_]*(:[0-5]?[0-9]){1,2}\.[0-9_]*$/mu.test(string)) {
    const parts = string.split(":");
    let total = 0;
    parts.forEach((n, e) => (total += Number.parseFloat(n.replaceAll("_", "")) * 60 ** Math.abs(e - 2)));
    return { kind: "float", value: new RubyFloat(total) };
  }
  if (lineMatch(FLOAT, string)) {
    if (/^[-+]?\.$/u.test(string)) return { kind: "string", value: string };
    return { kind: "float", value: new RubyFloat(Number(string.replaceAll(/[,_]/gu, "").replace(/\.([Ee]|$)/u, "$1"))) };
  }
  if (lineMatch(INTEGER_LEGACY, string)) return { kind: "int", value: parseRubyInteger(string) };
  return { kind: "string", value: string };
}
