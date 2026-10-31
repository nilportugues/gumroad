// Port of `serialize :attr, coder: YAML|JSON, type: Array|Hash` (ActiveRecord::Type::Serialized,
// Coders::ColumnSerializer and Coders::YAMLColumn, activerecord 8.1; json 2.13.2).
//
// Columns using it:
//   YAML: asset_previews.oembed, user_compliance_info.verticals (Array), sales_exports.query (Hash),
//         sales_export_chunks.purchase_ids / custom_fields / purchases_data (Array)
//   JSON: totp_credentials.recovery_codes, and json_data on every model including JsonData
import { hashFrom, psychDump, psychSafeLoad, RubyHash, type YamlValue } from "./psych";
import { jsonFloatToS } from "./ruby-json-float";
import { floatValue, isPlainHash, isRubyFloat, RubyFloat, RubySymbol } from "./ruby-values";

export type ObjectClass = "Object" | "Array" | "Hash";

// ActiveRecord::SerializationTypeMismatch
export class SerializationTypeMismatch extends Error {
  constructor(attribute: string, action: "dump" | "load", objectClass: ObjectClass, value: unknown) {
    super(`can't ${action} \`${attribute}\`: was supposed to be a ${objectClass}, but was a ${rubyClassName(value)}`);
    this.name = "SerializationTypeMismatch";
  }
}

function rubyClassName(value: unknown): string {
  if (value === null || value === undefined) return "NilClass";
  if (Array.isArray(value)) return "Array";
  if (typeof value === "string") return "String";
  if (typeof value === "boolean") return value ? "TrueClass" : "FalseClass";
  if (value instanceof RubySymbol) return "Symbol";
  if (isRubyFloat(value)) return "Float";
  if (typeof value === "number" || typeof value === "bigint") return "Integer";
  return "Hash";
}

function matchesClass(value: unknown, objectClass: ObjectClass): boolean {
  if (value == null || objectClass === "Object") return true;
  if (objectClass === "Array") return Array.isArray(value);
  return value instanceof RubyHash || isPlainHash(value);
}

const emptyFor = (objectClass: ObjectClass): YamlValue => (objectClass === "Array" ? [] : objectClass === "Hash" ? {} : null);

function isDefault(value: unknown, objectClass: ObjectClass): boolean {
  if (objectClass === "Array") return Array.isArray(value) && value.length === 0;
  if (objectClass === "Hash") return isPlainHash(value) && Object.keys(value).length === 0;
  return value == null;
}

type Coder = { dump(value: YamlValue): string; load(text: string): YamlValue };

function serializedColumn(attribute: string, coder: Coder, objectClass: ObjectClass) {
  return {
    // Type::Serialized#serialize: nil and the coder's empty default are stored as NULL.
    dump(value: YamlValue | undefined): string | null {
      if (value == null || isDefault(value, objectClass)) return null;
      if (!matchesClass(value, objectClass)) throw new SerializationTypeMismatch(attribute, "dump", objectClass, value);
      return coder.dump(value);
    },
    load(text: string | null): YamlValue {
      if (text == null) return emptyFor(objectClass);
      const value = coder.load(text);
      if (!matchesClass(value, objectClass)) throw new SerializationTypeMismatch(attribute, "load", objectClass, value);
      return value ?? emptyFor(objectClass);
    },
  };
}

export function yamlColumn(attribute: string, objectClass: ObjectClass = "Object") {
  return serializedColumn(attribute, { dump: psychDump, load: psychSafeLoad }, objectClass);
}

export function jsonColumn(attribute: string, objectClass: ObjectClass = "Object") {
  return serializedColumn(attribute, { dump: rubyJsonGenerate, load: rubyJsonParse }, objectClass);
}

// ---------------------------------------------------------------------------------------------
// JSON.dump (json 2.13.2): allow_nan, no script_safe escaping, Float#to_s for floats.

function escapeJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

export function rubyJsonGenerate(value: YamlValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (isRubyFloat(value)) {
    const f = floatValue(value);
    return Number.isNaN(f) ? "NaN" : f === Infinity ? "Infinity" : f === -Infinity ? "-Infinity" : jsonFloatToS(f);
  }
  if (typeof value === "string") return escapeJsonString(value);
  if (value instanceof RubySymbol) return escapeJsonString(value.name);
  if (Array.isArray(value)) return `[${value.map(rubyJsonGenerate).join(",")}]`;
  if (value instanceof RubyHash) {
    return `{${value.entries.map(([k, v]) => `${escapeJsonString(jsonKey(k))}:${rubyJsonGenerate(v)}`).join(",")}}`;
  }
  return `{${Object.entries(value).map(([k, v]) => `${escapeJsonString(k)}:${rubyJsonGenerate(v as YamlValue)}`).join(",")}}`;
}

function jsonKey(key: YamlValue): string {
  if (typeof key === "string") return key;
  if (key instanceof RubySymbol) return key.name;
  if (key === null) return "";
  return rubyJsonGenerate(key).replace(/^"|"$/gu, "");
}

// JSON.load: numbers with a fraction or exponent are Floats, others Integers (bigint past 2^53).
// Parsed by hand because JSON.parse reorders array-index keys, which Ruby hashes do not.
export function rubyJsonParse(text: string): YamlValue {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const fail = (): never => {
    throw new SyntaxError(`unexpected token at offset ${i} in JSON`);
  };
  const value = (): YamlValue => {
    ws();
    const ch = text[i];
    if (ch === "{") {
      i++;
      const entries: [YamlValue, YamlValue][] = [];
      ws();
      if (text[i] === "}") return i++, hashFrom(entries);
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = string();
        ws();
        if (text[i++] !== ":") fail();
        entries.push([key, value()]);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return i++, hashFrom(entries);
        else fail();
      }
    }
    if (ch === "[") {
      i++;
      const items: YamlValue[] = [];
      ws();
      if (text[i] === "]") return i++, items;
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return i++, items;
        else fail();
      }
    }
    if (ch === '"') return string();
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) return (i += word.length), result;
    }
    const m = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/uy;
    m.lastIndex = i;
    const num = m.exec(text) ?? fail();
    i += num[0].length;
    const n = Number(num[0]);
    if (num[1] !== undefined || num[2] !== undefined) return Number.isInteger(n) ? new RubyFloat(n) : n;
    return Number.isSafeInteger(n) ? n : BigInt(num[0]);
  };
  const string = (): string => {
    const m = /"(?:[^"\\\u0000-\u001f]|\\.)*"/uy;
    m.lastIndex = i;
    const raw = m.exec(text) ?? fail();
    i += raw[0].length;
    return JSON.parse(raw[0]) as string;
  };
  const result = value();
  ws();
  if (i !== text.length) fail();
  return result;
}
