// The JsonData concern (app/models/concerns/json_data.rb): `serialize :json_data, coder: JSON`, the
// `json_data` reader, attr_json_data_accessor and merge_json_data_with_current_row. The column stays
// as its JSON text on the record; the parsed hash is kept beside it.
import { Prisma } from "@prisma/client";

import type { Callback } from "../runtime/define-model.ts";
import type { ModelRecord, Row } from "../runtime/record.ts";
import { isBlank } from "../runtime/validators.ts";
import { column, table } from "../sql.ts";
import { RubyHash, type YamlValue } from "./psych.ts";
import { isRubyFloat } from "./ruby-values.ts";
import { rubyJsonGenerate, rubyJsonParse } from "./serialized-columns.ts";

type JsonDataRow = Row & { json_data: string | null };
type JsonDataState = { hash: RubyHash };
const JSON_DATA = Symbol("json_data");

export function toHash(value: YamlValue): RubyHash | null {
  if (value instanceof RubyHash) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !isRubyFloat(value)) return new RubyHash(Object.entries(value));
  return null;
}

export function jsonGet(hash: RubyHash, key: string): YamlValue | undefined {
  return hash.entries.find(([k]) => k === key)?.[1];
}

// JsonData#json_data: `self[:json_data] ||= {}`, and raises unless it is a Hash. Reading it also
// makes Rails compare the re-serialized value with the stored text, so the attribute is rewritten
// with the canonical JSON here; a NULL or differently formatted column then counts as changed.
export function jsonData<R extends JsonDataRow>(record: ModelRecord<R>): RubyHash {
  const ivars = record.ivars as Record<symbol, JsonDataState | undefined>;
  let state = ivars[JSON_DATA];
  const raw = record.get("json_data");
  if (!state || rubyJsonGenerate(state.hash) !== raw) {
    const parsed = raw == null ? null : rubyJsonParse(raw);
    const hash = parsed == null ? new RubyHash([]) : toHash(parsed);
    if (!hash) throw new Error("json_data must be a hash");
    state = { hash };
    ivars[JSON_DATA] = state;
  }
  // `self[:json_data] ||= {}` writes only when the column is nil; the rest edits the hash in place.
  if (raw == null) record.set("json_data", rubyJsonGenerate(state.hash) as R["json_data"]);
  else record.untracked(() => record.set("json_data", rubyJsonGenerate(state.hash) as R["json_data"]));
  return state.hash;
}

// json_data_for_attr: the stored value when present, else the default.
export function jsonDataForAttr<R extends JsonDataRow>(record: ModelRecord<R>, key: string, fallback: YamlValue = null): YamlValue {
  const value = jsonGet(jsonData(record), key);
  return value === undefined || isBlank(value) ? fallback : value;
}

export function setJsonDataForAttr<R extends JsonDataRow>(record: ModelRecord<R>, key: string, value: YamlValue): void {
  const hash = jsonData(record);
  const entry = hash.entries.find(([k]) => k === key);
  if (entry) entry[1] = value;
  else hash.entries.push([key, value]);
  record.untracked(() => record.set("json_data", rubyJsonGenerate(hash) as R["json_data"]));
}

// JsonData#merge_json_data_with_current_row: rebase this instance's json_data delta onto the row. `type` is the STI class: `unscoped` keeps its type condition, so the locking read carries it.
export function mergeJsonDataWithCurrentRow<R extends JsonDataRow>(tableName: string, options: { type?: string } = {}): Callback<R> {
  return {
    name: "merge_json_data_with_current_row",
    if: (r) => r.persisted && r.attributeChanged("json_data"),
    async run(record, { tx }) {
      const was = record.attributeInDatabase("json_data");
      const wasParsed = was == null ? null : rubyJsonParse(was);
      const base = toHash(wasParsed as YamlValue) ?? new RubyHash([]);
      const mine = jsonData(record);
      const [row] = await tx.$queryRaw<{ json_data: string | null }[]>(
        Prisma.sql`SELECT ${column(tableName, "json_data")} FROM ${table(tableName)} WHERE ${options.type === undefined ? Prisma.empty : Prisma.sql`${column(tableName, "type")} = ${options.type} AND `}${column(tableName, "id")} = ${record.get("id")} LIMIT 1 FOR UPDATE`,
      );
      const currentText = row?.json_data ?? null;
      const current = currentText == null ? null : rubyJsonParse(currentText);
      if (current == null) return;
      const merged = toHash(current) ?? new RubyHash([]);
      const keys = [...new Set([...base.entries.map(([k]) => k as string), ...mine.entries.map(([k]) => k as string)])];
      for (const key of keys) {
        const b = jsonGet(base, key);
        const m = jsonGet(mine, key);
        if ((b === undefined) === (m === undefined) && (b === undefined || rubyJsonGenerate(b) === rubyJsonGenerate(m!))) continue;
        const index = merged.entries.findIndex(([k]) => k === key);
        if (m !== undefined) {
          if (index === -1) merged.entries.push([key, m]);
          else merged.entries[index]![1] = m;
        } else if (index !== -1) merged.entries.splice(index, 1);
      }
      (record.ivars as Record<symbol, JsonDataState>)[JSON_DATA] = { hash: merged };
      record.set("json_data", rubyJsonGenerate(merged) as R["json_data"]);
    },
  };
}
