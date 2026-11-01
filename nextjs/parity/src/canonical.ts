// The TypeScript half of spec/support/parity/canonical.rb. Both must produce identical output;
// __tests__/canonical-vectors.json runs against each. Change all four files together.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const NOW_TOLERANCE_SECONDS = 5;

const INTEGER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "bigint", "bit"]);
const TIME_TYPES = new Set(["datetime", "timestamp"]);
const BINARY_TYPES = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"]);

// Response cookies minted fresh on every request (ApplicationController#set_gumroad_guid's
// SecureRandom.uuid): their presence and attributes are the contract, the value is not.
const VOLATILE_COOKIES = new Set(["_gumroad_guid"]);
export const VOLATILE_VALUE = "<volatile>";

export function cookieValue(name: string, value: string): string {
  return VOLATILE_COOKIES.has(name) ? VOLATILE_VALUE : value;
}

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
const TIME_TOKEN = /^<now(?:([+-])(\d+)([smh]))?>$/;
const DATE_TOKEN = /^<today(?:([+-])(\d+)d)?>$/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600 } as const;

export function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

export function selectExpression(column: string, dataType: string): string {
  const quoted = quoteIdentifier(column);
  if (BINARY_TYPES.has(dataType)) return `TO_BASE64(${quoted})`;
  if (dataType === "bit") return `CAST(CAST(${quoted} AS UNSIGNED) AS CHAR)`;
  return `CAST(${quoted} AS CHAR)`;
}

export function integer(value: bigint): Json {
  const abs = value < 0n ? -value : value;
  return abs > BigInt(Number.MAX_SAFE_INTEGER) ? { $big: value.toString() } : Number(value);
}

export function dbValue(raw: string | null, dataType: string, now: Date): Json {
  if (raw === null) return null;
  if (INTEGER_TYPES.has(dataType)) return integer(BigInt(raw));
  if (TIME_TYPES.has(dataType)) {
    const time = parseDbTime(raw);
    return time ? timeToken(time, now) : raw;
  }
  if (dataType === "date") {
    const date = parseDate(raw);
    return date ? dateToken(date, now) : raw;
  }
  if (BINARY_TYPES.has(dataType)) return { $base64: raw.replaceAll("\n", "") };
  return raw;
}

export const EPOCH_TOKEN = "<epoch>";
// A { name, offset } time zone prop whose offset is the one in force at `now`, so a fixture
// recorded in summer still replays after the daylight saving change.
export const UTC_OFFSET_TOKEN = "<utc_offset>";

export function timeToken(time: Date, now: Date): string {
  // A deleted cookie expires at the epoch; relative to now it would drift with the calendar.
  if (time.getTime() === 0) return EPOCH_TOKEN;
  const delta = (time.getTime() - now.getTime()) / 1000;
  if (Math.abs(delta) <= NOW_TOLERANCE_SECONDS) return "<now>";
  return `<now${offset(delta)}>`;
}

export function dateToken(date: Date, now: Date): string {
  const days = Math.round((date.getTime() - utcMidnight(now)) / 86_400_000);
  return days === 0 ? "<today>" : `<today${days < 0 ? "-" : "+"}${Math.abs(days)}d>`;
}

function offset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  if (abs < 60) return `${sign}${Math.round(abs / 5) * 5}s`;
  if (abs < 86_400) return `${sign}${Math.round(abs / 60)}m`;
  return `${sign}${Math.round(abs / 3600)}h`;
}

function utcMidnight(time: Date): number {
  return Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
}

// Rails writes UTC into DATETIME columns; "0000-00-00 ..." and other junk stay raw.
export function parseDbTime(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction = ""] = match;
  const ms = Number(fraction.padEnd(3, "0").slice(0, 3));
  const time = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms));
  return time.getUTCMonth() === Number(mo) - 1 && time.getUTCDate() === Number(d) ? time : null;
}

function parseDate(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCDate() === Number(match[3]) ? date : null;
}

// Inverse of timeToken/dateToken, used when seeding the replay database.
export function resolveTimeToken(token: string, now: Date): Date | null {
  const match = TIME_TOKEN.exec(token);
  if (!match) return null;
  const [, sign, amount, unit] = match;
  if (!sign) return new Date(now);
  const seconds = Number(amount) * UNIT_SECONDS[unit as keyof typeof UNIT_SECONDS];
  return new Date(now.getTime() + (sign === "-" ? -seconds : seconds) * 1000);
}

export function resolveDateToken(token: string, now: Date): Date | null {
  const match = DATE_TOKEN.exec(token);
  if (!match) return null;
  const days = match[1] ? Number(match[2]) * (match[1] === "-" ? -1 : 1) : 0;
  return new Date(utcMidnight(now) + days * 86_400_000);
}

export function string(value: string, now: Date): string {
  return value.replace(ISO_TIME, (match) => {
    // Ruby's Time.iso8601 accepts "+0000"; Date only parses "+00:00".
    const time = new Date(match.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isNaN(time.getTime()) ? match : timeToken(time, now);
  });
}

export function json(value: unknown, now: Date): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return string(value, now);
  if (typeof value === "bigint") return integer(value);
  if (typeof value === "number") return Number.isInteger(value) ? integer(BigInt(value)) : value;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return timeToken(value, now);
  if (Array.isArray(value)) return value.map((item) => json(item, now));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "time_zone" ? timeZone(item, now) : json(item, now)]));
  }
  return String(value);
}

function timeZone(value: unknown, now: Date): Json {
  const zone = json(value, now);
  if (zone === null || typeof zone !== "object" || Array.isArray(zone)) return zone;
  if (typeof zone.name !== "string" || typeof zone.offset !== "number" || !Number.isInteger(zone.offset)) return zone;
  return zone.offset === utcOffset(zone.name, now) ? { ...zone, offset: UTC_OFFSET_TOKEN } : zone;
}

function utcOffset(name: string, now: Date): number | null {
  let part: string | undefined;
  try {
    part = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "longOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return null;
  }
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part ?? "");
  if (!match) return null;
  if (!match[1]) return 0;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
  return match[1] === "-" ? -seconds : seconds;
}

// JSON.parse that keeps integers outside the safe range exact, as { $big }, the way Ruby writes them.
export function parseJson(text: string): Json {
  return JSON.parse(text, function (this: unknown, _key, value, context?: { source?: string }) {
    if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
      return { $big: context.source };
    }
    return value;
  }) as Json;
}

export type ColumnSpec = [name: string, dataType: string];

// Mirrors the dump shape in canonical.rb: raw strings in primary-key order.
export type TableDump = {
  columns: ColumnSpec[];
  primaryKey: string[];
  rows: (string | null)[][];
};

export type Tables = Record<string, TableDump>;

export type TableDiff = {
  inserted?: Record<string, Json>[];
  updated?: { key: Record<string, Json>; changes: Record<string, [Json, Json]> }[];
  deleted?: Record<string, Json>[];
};

export function row(dump: TableDump, rawRow: (string | null)[], now: Date): Record<string, Json> {
  return Object.fromEntries(dump.columns.map(([name, type], index) => [name, dbValue(rawRow[index] ?? null, type, now)]));
}

// Changes are detected on raw values, so an updated_at that moved within the "<now>" tolerance
// still shows up as changed even though both sides print the same token.
export function diff(before: Tables, after: Tables, now: Date): Record<string, TableDiff> {
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: Record<string, TableDiff> = {};
  for (const table of tables) {
    const dump = (after[table] ?? before[table])!;
    const oldRows = indexRows(dump, before[table]?.rows ?? []);
    const newRows = indexRows(dump, after[table]?.rows ?? []);

    const inserted = [...newRows].filter(([key]) => !oldRows.has(key)).map(([, raw]) => row(dump, raw, now));
    const deleted = [...oldRows].filter(([key]) => !newRows.has(key)).map(([, raw]) => row(dump, raw, now));
    const updated: NonNullable<TableDiff["updated"]> = [];
    for (const [key, oldRow] of oldRows) {
      const newRow = newRows.get(key);
      if (!newRow) continue;
      const changes: Record<string, [Json, Json]> = {};
      dump.columns.forEach(([name, type], index) => {
        const was = oldRow[index] ?? null;
        const is = newRow[index] ?? null;
        if (was !== is) changes[name] = [dbValue(was, type, now), dbValue(is, type, now)];
      });
      if (Object.keys(changes).length > 0) updated.push({ key: keyOf(dump, oldRow, now), changes });
    }

    const tableDiff: TableDiff = {};
    if (inserted.length) tableDiff.inserted = inserted;
    if (updated.length) tableDiff.updated = updated;
    if (deleted.length) tableDiff.deleted = deleted;
    if (Object.keys(tableDiff).length) out[table] = tableDiff;
  }
  return out;
}

function primaryKeyPositions(dump: TableDump): number[] | null {
  if (dump.primaryKey.length === 0) return null;
  const names = dump.columns.map(([name]) => name);
  return dump.primaryKey.map((key) => names.indexOf(key));
}

// Keys must match Ruby's JSON.generate of the same raw values, so ordering of the Map follows the dump.
function indexRows(dump: TableDump, rows: (string | null)[][]): Map<string, (string | null)[]> {
  const positions = primaryKeyPositions(dump);
  return new Map(rows.map((raw) => [JSON.stringify(positions ? positions.map((i) => raw[i] ?? null) : raw), raw]));
}

function keyOf(dump: TableDump, rawRow: (string | null)[], now: Date): Record<string, Json> {
  const full = row(dump, rawRow, now);
  if (dump.primaryKey.length === 0) return full;
  return Object.fromEntries(dump.primaryKey.map((key) => [key, full[key] ?? null]));
}
