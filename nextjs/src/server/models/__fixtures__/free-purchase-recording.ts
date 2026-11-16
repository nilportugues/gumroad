// Reads what the Rails recording of POST /orders (spec/requests/orders_free_purchase_parity_spec.rb) wrote for one
// fixture: the rows each table gained and the interleaved write/enqueue timeline. Model tests compare the rows
// their saves produce against these.
import { readFileSync } from "node:fs";

const DIR = new URL("../../../../parity/fixtures/requests/orders_free_purchase_parity_spec/", import.meta.url);
export const PLAIN_FIXTURE = "orders-free-purchase-creates-a-free-purchase-for-a-signed-out-buyer";

export type RecordedRow = Record<string, unknown>;
type RecordedTable = {
  inserted?: RecordedRow[];
  updated?: { key: { id: number }; changes: Record<string, [unknown, unknown]> }[];
};
export type RecordedTimelineEntry = { type: "db"; op: string; table: string } | { type: "job"; index: number };
export type RecordedExchange = {
  seed: unknown;
  request: { body: string; headers: Record<string, string>; cookies: Record<string, string>; remoteIp: string };
  response: { status: number; json: Record<string, unknown> };
  db: Record<string, RecordedTable>;
  jobs: { class: string; args: unknown[]; queue: string; at?: string }[];
  timeline: RecordedTimelineEntry[];
};

export function lastExchange(fixture: string = PLAIN_FIXTURE): RecordedExchange {
  const parsed = JSON.parse(readFileSync(new URL(`${fixture}.json`, DIR), "utf8")) as { exchanges: RecordedExchange[] };
  return parsed.exchanges.at(-1)!;
}

export function insertedRow(table: string, fixture?: string): RecordedRow {
  const row = lastExchange(fixture).db[table]?.inserted?.[0];
  if (!row) throw new Error(`fixture records no ${table} insert`);
  return row;
}

// The recorder masks timestamps as "<now>"; a save stamps them from its clock.
export const RECORDED_NOW = new Date("2026-05-01T12:00:00.000Z");

// A row as the model hands it to Prisma, in the recording's terms: BigInt as Number, a stamped time as "<now>".
export function recorded(data: Record<string, unknown> | undefined): RecordedRow {
  return Object.fromEntries(
    Object.entries(data ?? {}).map(([key, value]) => [
      key,
      value instanceof Date ? "<now>" : typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

// The attributes a caller assigns: everything the database or the clock fills in is left out.
export function assigned(row: RecordedRow, omit: string[] = []): RecordedRow {
  const skip = new Set(["id", "created_at", "updated_at", ...omit]);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !skip.has(key)));
}
