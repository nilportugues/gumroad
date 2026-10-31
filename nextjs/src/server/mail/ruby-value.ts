// Mailer arguments as Ruby holds them after ActiveJob deserializes a delivery, and Ruby 3.4's
// #inspect of them, which MailerInfo writes into the X-GUM / X-SMTPAPI headers. Only the shapes
// mailers are called with are ported; anything else throws MailArgumentNotPortedError so the
// delivery is left to Rails.

export class MailArgumentNotPortedError extends Error {}

export class RubySymbol {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class RubyHash {
  readonly entries: [RubyValue, RubyValue][];
  constructor(entries: [RubyValue, RubyValue][]) {
    this.entries = entries;
  }

  get(key: string): RubyValue | undefined {
    return this.entries.find(([k]) => k instanceof RubySymbol && k.name === key)?.[1];
  }
}

// A record argument (`_aj_globalid`); its #inspect is the whole row, which is not ported.
export class GlobalIdRef {
  readonly gid: string;
  constructor(gid: string) {
    this.gid = gid;
  }
}

export type RubyValue = null | boolean | number | bigint | string | RubySymbol | RubyHash | GlobalIdRef | RubyValue[];

const NAMED_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\f": "\\f", "\v": "\\v", "\b": "\\b", "\x07": "\\a", "\x1b": "\\e" };

// String#inspect for a UTF-8 string. Which non-ASCII characters Ruby treats as printable depends
// on Onigmo's tables, so they are refused rather than guessed.
export function inspectString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = ch.charCodeAt(0);
    if (code > 0x7e && code !== 0x7f) throw new MailArgumentNotPortedError("non-ASCII string argument");
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (ch === "#" && /[{$@]/u.test(value[i + 1] ?? "")) out += "\\#";
    else if (NAMED_ESCAPES[ch]) out += NAMED_ESCAPES[ch];
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function inspectSymbol(symbol: RubySymbol): string {
  const { name } = symbol;
  if (/^[A-Za-z_][A-Za-z0-9_]*[?!=]?$/u.test(name) || /^(?:@@?|\$)[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return `:${name}`;
  if (/^[A-Za-z0-9_ ]*$/u.test(name)) return `:${inspectString(name)}`;
  throw new MailArgumentNotPortedError(`symbol :${name}`);
}

// Ruby 3.4's Hash#inspect writes `key: value` for a symbol key that reads back as a label.
function inspectHashKey(key: RubyValue): string {
  if (key instanceof RubySymbol) {
    if (IDENTIFIER.test(key.name) || /^[A-Za-z_][A-Za-z0-9_]*[?!]$/u.test(key.name)) return `${key.name}: `;
    return `${inspectString(key.name)}: `;
  }
  return `${inspect(key)} => `;
}

export function inspect(value: RubyValue): string {
  if (value === null) return "nil";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new MailArgumentNotPortedError(`numeric argument ${value}`);
    return String(value);
  }
  if (typeof value === "string") return inspectString(value);
  if (value instanceof RubySymbol) return inspectSymbol(value);
  if (Array.isArray(value)) return `[${value.map(inspect).join(", ")}]`;
  if (value instanceof RubyHash) {
    if (value.entries.length === 0) return "{}";
    return `{${value.entries.map(([k, v]) => `${inspectHashKey(k)}${inspect(v)}`).join(", ")}}`;
  }
  throw new MailArgumentNotPortedError("record argument (GlobalID)");
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ActiveJob::Arguments.deserialize for primitives, arrays, symbol- and string-keyed hashes,
// keyword hashes, symbols and records.
export function deserializeArgument(argument: unknown): RubyValue {
  if (argument === null || typeof argument === "boolean" || typeof argument === "string" || typeof argument === "bigint") return argument;
  if (typeof argument === "number") {
    if (!Number.isSafeInteger(argument)) throw new MailArgumentNotPortedError(`numeric argument ${argument}`);
    return argument;
  }
  if (Array.isArray(argument)) return argument.map(deserializeArgument);
  if (!isPlainObject(argument)) throw new MailArgumentNotPortedError(`ActiveJob argument ${String(argument)}`);

  const keys = Object.keys(argument);
  if (keys.length === 1 && typeof argument._aj_globalid === "string") return new GlobalIdRef(argument._aj_globalid);
  if (argument._aj_serialized === "ActiveJob::Serializers::SymbolSerializer" && typeof argument.value === "string" && keys.length === 2) {
    return new RubySymbol(argument.value);
  }
  const symbolKeys = argument._aj_symbol_keys ?? argument._aj_ruby2_keywords;
  const marker = "_aj_symbol_keys" in argument ? "_aj_symbol_keys" : "_aj_ruby2_keywords";
  if (keys.some((key) => key.startsWith("_aj_") && key !== marker) || (symbolKeys !== undefined && !Array.isArray(symbolKeys))) {
    throw new MailArgumentNotPortedError(`ActiveJob hash ${JSON.stringify(keys)}`);
  }
  const symbols = new Set((symbolKeys as string[] | undefined) ?? []);
  return new RubyHash(
    keys.filter((key) => key !== marker).map((key): [RubyValue, RubyValue] => [symbols.has(key) ? new RubySymbol(key) : key, deserializeArgument(argument[key])]),
  );
}
