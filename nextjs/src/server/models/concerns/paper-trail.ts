// Port of `has_paper_trail` (paper_trail 17.0.0) as Gumroad configures it: the JSON serializer
// (config/initializers/paper_trail.rb), text `object`/`object_changes` columns, controller info
// from ApplicationController#info_for_paper_trail, and ActiveSupport's JSON encoding with
// time_precision 0 and HTML/JS-separator escaping (config/application.rb,
// config/initializers/json_time_precision.rb).
//
// Callbacks registered, as ModelConfig#setup does for the default `on: [:create, :update, :destroy, :touch]`:
//   after_create → record_create, after_update → record_update, before_destroy → record_destroy.
// The runtime has no `touch`, so on_touch is not ported.
import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma } from "@prisma/client";

import type { Callback, CallbackContext } from "../runtime/define-model.ts";
import type { ModelRecord, Row } from "../runtime/record.ts";
import { RubyHash } from "./psych.ts";
import { jsonFloatToS } from "./ruby-json-float.ts";
import { floatValue, isRubyFloat, RubyFloat, RubySymbol } from "./ruby-values.ts";

export type ColumnType = "integer" | "float" | "decimal" | "boolean" | "string" | "text" | "json" | "date" | "datetime";
export type VersionEvent = "create" | "update" | "destroy";

export type PaperTrailOptions = {
  // base_class.name: STI subclasses version under their base class.
  itemType: string;
  only?: string[];
  skip?: string[];
  ignore?: string[];
  // Defaults to the Prisma model's columns; tests pass them explicitly.
  columnTypes?: Record<string, ColumnType>;
};

export type VersionRow = {
  item_type: string;
  item_id: unknown;
  event: string;
  whodunnit: string | null;
  object: string | null;
  object_changes: string | null;
  created_at: Date;
} & Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// PaperTrail.enabled? and PaperTrail.request

export type PaperTrailRequest = {
  whodunnit?: string | number | null;
  // ApplicationController#info_for_paper_trail: remote_ip, request_path, request_uuid.
  controllerInfo?: Record<string, string | null>;
  enabled?: boolean;
  disabledModels?: string[];
};

const requestStore = new AsyncLocalStorage<PaperTrailRequest>();
let globallyEnabled = true;

export function setPaperTrailEnabled(enabled: boolean): void {
  globallyEnabled = enabled;
}

export function withPaperTrailRequest<T>(request: PaperTrailRequest, fn: () => T): T {
  return requestStore.run({ ...requestStore.getStore(), ...request }, fn);
}

function currentRequest(): PaperTrailRequest {
  return requestStore.getStore() ?? {};
}

function enabledFor(itemType: string): boolean {
  const request = currentRequest();
  return globallyEnabled && request.enabled !== false && !(request.disabledModels ?? []).includes(itemType);
}

// ---------------------------------------------------------------------------------------------
// ActiveSupport::JSON.encode

const AS_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  " ": "\\u2028",
  " ": "\\u2029",
};

// escape: false (Type::Json#serialize) keeps only the escapes JSON itself requires.
const JSON_ONLY = new Set(['"', "\\", "\b", "\f", "\n", "\r", "\t"]);

function encodeString(s: string, escape = true): string {
  let out = '"';
  for (const ch of s) {
    const escaped = escape || JSON_ONLY.has(ch) ? AS_ESCAPES[ch] : undefined;
    if (escaped) out += escaped;
    else if (ch.codePointAt(0)! < 0x20) out += `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

// Float#as_json turns NaN and Infinity into nil.
function encodeFloat(f: number): string {
  return Number.isFinite(f) ? jsonFloatToS(f) : "null";
}

// Time#as_json is xmlschema(time_precision), and time_precision is 0.
const encodeTime = (d: Date) => `"${d.toISOString().slice(0, 19)}Z"`;
const encodeDate = (d: Date) => `"${d.toISOString().slice(0, 10)}"`;

// BigDecimal#as_json is to_s, which ActiveSupport makes to_s("F"): always a fraction, never an exponent.
function encodeDecimal(value: unknown): string {
  const fixed = new Prisma.Decimal(value as Prisma.Decimal.Value).toFixed();
  return `"${fixed.includes(".") ? fixed : `${fixed}.0`}"`;
}

export function activeSupportJsonEncode(value: unknown, options: { escape?: boolean } = {}): string {
  const escape = options.escape ?? true;
  const encode = (v: unknown) => activeSupportJsonEncode(v, options);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : encodeFloat(value);
  if (value instanceof RubyFloat) return encodeFloat(value.value);
  if (typeof value === "string") return encodeString(value, escape);
  if (value instanceof RubySymbol) return encodeString(value.name, escape);
  if (value instanceof Date) return encodeTime(value);
  if (Prisma.Decimal.isDecimal(value)) return encodeDecimal(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  const entries = value instanceof RubyHash ? value.entries.map(([k, v]) => [hashKey(k), v] as const) : Object.entries(value as object);
  return `{${entries.map(([k, v]) => `${encodeString(k, escape)}:${encode(v)}`).join(",")}}`;
}

// Hash#as_json stringifies keys with to_s.
function hashKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (key instanceof RubySymbol) return key.name;
  if (key == null) return "";
  if (isRubyFloat(key)) return String(floatValue(key));
  return String(key);
}

// CastAttributeSerializer#serialize (the column type's `serialize`) followed by as_json, as a
// JSON fragment. Serialized YAML/JSON text columns already hold their database text here.
function encodeAttribute(type: ColumnType | undefined, value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (type) {
    case "json":
      return encodeString(activeSupportJsonEncode(value, { escape: false }));
    case "date":
      return value instanceof Date ? encodeDate(value) : activeSupportJsonEncode(value);
    case "datetime":
      return value instanceof Date ? encodeTime(value) : activeSupportJsonEncode(value);
    case "float":
      return typeof value === "number" || value instanceof RubyFloat ? encodeFloat(floatValue(value)) : activeSupportJsonEncode(value);
    case "decimal":
      return encodeDecimal(value);
    default:
      return activeSupportJsonEncode(value);
  }
}

export function columnTypesFromPrisma(model: Prisma.ModelName): Record<string, ColumnType> {
  const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!dmmf) throw new Error(`Unknown Prisma model ${model}`);
  const types: Record<string, ColumnType> = {};
  for (const f of dmmf.fields) {
    if (f.kind !== "scalar" && f.kind !== "enum") continue;
    const native = (f.nativeType as [string, string[]] | null | undefined)?.[0];
    types[f.name] =
      f.type === "Int" || f.type === "BigInt"
        ? "integer"
        : f.type === "Float"
          ? "float"
          : f.type === "Decimal"
            ? "decimal"
            : f.type === "Boolean"
              ? "boolean"
              : f.type === "Json"
                ? "json"
                : f.type === "DateTime"
                  ? native === "Date"
                    ? "date"
                    : "datetime"
                  : "string";
  }
  return types;
}

// ---------------------------------------------------------------------------------------------
// Events::Create / Update / Destroy

const UPDATE_TIMESTAMPS = ["updated_at", "updated_on"];

export type Resolved = Required<Omit<PaperTrailOptions, "columnTypes">> & { columnTypes: Record<string, ColumnType> };

// A loaded record's `attributes` lists the attributes ActiveModel::LazyAttributeSet materialized
// (written or dirty-checked) first, in that order, then the rest in column order. Models that
// track it put the materialized names in `ivars[MATERIALIZED_ATTRIBUTES]`; others get column order.
export const MATERIALIZED_ATTRIBUTES = "materialized_attributes";

function attributeOrder(record: ModelRecord): string[] {
  const columns = Object.keys(record.attributes);
  const first = (record.ivars[MATERIALIZED_ATTRIBUTES] as string[] | undefined) ?? [];
  return [...new Set([...first.filter((k) => columns.includes(k)), ...columns])];
}

function encodeObject(record: ModelRecord, config: Resolved, valueOf: (name: string) => unknown): string {
  const names = attributeOrder(record).filter((k) => !config.skip.includes(k));
  return `{${names.map((k) => `${encodeString(k)}:${encodeAttribute(config.columnTypes[k], valueOf(k))}`).join(",")}}`;
}

function encodeChanges(changes: [string, [unknown, unknown]][], config: Resolved): string {
  return `{${changes
    .map(([k, [a, b]]) => `${encodeString(k)}:[${encodeAttribute(config.columnTypes[k], a)},${encodeAttribute(config.columnTypes[k], b)}]`)
    .join(",")}}`;
}

// Base#notably_changed and #changed_notably?
function notable(changed: string[], record: ModelRecord, config: Resolved) {
  const cani = changed.filter((k) => !config.ignore.includes(k) && !config.skip.includes(k));
  const notablyChanged = config.only.length === 0 ? cani : cani.filter((k) => config.only.includes(k));
  const ignoredChanged = changed.some((k) => config.ignore.includes(k) || config.skip.includes(k));
  const timestamps = UPDATE_TIMESTAMPS.filter((k) => k in record.attributes);
  const changedNotably = ignoredChanged ? notablyChanged.some((k) => !timestamps.includes(k)) : notablyChanged.length > 0;
  return { notablyChanged, changedNotably };
}

// Builds the `versions` row PaperTrail would insert, or null when an update is not notable.
// Create and update run in after_* callbacks and read saved_changes; destroy runs before_destroy
// and reads the database values.
export function buildVersion(event: VersionEvent, record: ModelRecord, config: Resolved, now: Date): VersionRow | null {
  const request = currentRequest();
  const eventName = (record.ivars.paper_trail_event as string | undefined) ?? event;
  let object: string | null = null;
  let objectChanges: string | null = null;
  // Create and update copy the record's updated_at; with none, ActiveRecord stamps the insert.
  let createdAt = now;

  if (event === "destroy") {
    const changes = Object.entries(record.attributes).map(([k, v]) => [k, [v, null]] as [string, [unknown, unknown]]);
    const { notablyChanged } = notable(
      changes.map(([k]) => k),
      record,
      config,
    );
    object = encodeObject(record, config, (k) => record.attributeInDatabase(k));
    objectChanges = encodeChanges(
      changes.filter(([k]) => notablyChanged.includes(k)),
      config,
    );
  } else {
    const saved = Object.entries(record.savedChanges) as [string, [unknown, unknown]][];
    const { notablyChanged, changedNotably } = notable(
      saved.map(([k]) => k),
      record,
      config,
    );
    if (event === "update" && !changedNotably) return null;
    const changes = saved.filter(([k]) => notablyChanged.includes(k));
    if (event === "update") {
      object = encodeObject(record, config, (k) => record.attributeBeforeLastSave(k));
      objectChanges = encodeChanges(changes, config);
    } else if (changedNotably) {
      objectChanges = encodeChanges(changes, config);
    }
    if ("updated_at" in record.attributes) createdAt = (record.get("updated_at") as Date | null) ?? now;
  }

  return {
    item_type: config.itemType,
    item_id: record.get("id"),
    event: eventName,
    whodunnit: request.whodunnit == null ? null : String(request.whodunnit),
    object,
    object_changes: objectChanges,
    created_at: createdAt,
    // partial_inserts is off, so a version written outside a request still names these columns.
    remote_ip: null,
    request_path: null,
    request_uuid: null,
    ...request.controllerInfo,
  };
}

// ---------------------------------------------------------------------------------------------
// has_paper_trail

export type PaperTrailCallbacks<R extends Row> = {
  afterCreate: Callback<R>[];
  afterUpdate: Callback<R>[];
  beforeDestroy: Callback<R>[];
};

// Spread these first into the model definition: has_paper_trail is declared at the top of every
// versioned model, so its callbacks run before the model's own.
export function hasPaperTrail<R extends Row>(prismaModel: Prisma.ModelName, options: PaperTrailOptions): PaperTrailCallbacks<R> {
  let resolved: Resolved | null = null;
  const config = () =>
    (resolved ??= {
      itemType: options.itemType,
      only: options.only ?? [],
      skip: options.skip ?? [],
      ignore: options.ignore ?? [],
      columnTypes: options.columnTypes ?? columnTypesFromPrisma(prismaModel),
    });

  const record = (event: VersionEvent) => async (r: ModelRecord<R>, { tx }: CallbackContext) => {
    if (!enabledFor(options.itemType)) return;
    if (event === "destroy" && r.newRecord) return;
    const data = buildVersion(event, r as unknown as ModelRecord, config(), new Date());
    if (!data) return;
    try {
      await tx.version.create({ data: data as Prisma.VersionUncheckedCreateInput });
    } catch (error) {
      // version_error_behavior :legacy raises on create and only logs on update and destroy.
      if (event === "create") throw error;
      console.error(`PaperTrail ${event} version for ${options.itemType} could not be saved`, error);
    }
  };

  return {
    afterCreate: [{ name: "paper_trail.record_create", run: record("create") }],
    afterUpdate: [{ name: "paper_trail.record_update", run: record("update") }],
    beforeDestroy: [{ name: "paper_trail.record_destroy", run: record("destroy") }],
  };
}
