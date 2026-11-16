// PublicSuffix.valid? and PublicSuffix.parse (public_suffix 5.1.1) over the gem's bundled list,
// private domains included. Golden: __fixtures__/public-suffix.golden.json
// (scripts/golden/public-suffix.rb, which also writes the list).
import LIST from "./public-suffix-list.generated.json" with { type: "json" };

type RuleType = "normal" | "wildcard" | "exception";
type Rule = { type: RuleType; value: string; length: number };

export class DomainInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicSuffix::DomainInvalid";
  }
}

export class DomainNotAllowed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicSuffix::DomainNotAllowed";
  }
}

export type ParsedDomain = { tld: string; sld: string | null; trd: string | null; domain: string | null };

// Rule.factory: the value drops the "*." / "!" prefix; a wildcard counts its star as a label.
function build(line: string): Rule {
  if (line.startsWith("*")) {
    const value = line.slice(2);
    return { type: "wildcard", value, length: value.split(".").length + 1 };
  }
  if (line.startsWith("!")) {
    const value = line.slice(1);
    return { type: "exception", value, length: value.split(".").length };
  }
  return { type: "normal", value: line, length: line.split(".").length };
}

let rules: Map<string, Rule> | null = null;
// List#add keys rules by value, so a later rule replaces an earlier one with the same value.
function list(): Map<string, Rule> {
  if (rules) return rules;
  rules = new Map();
  for (const line of LIST.rules) {
    const rule = build(line);
    rules.set(rule.value, rule);
  }
  return rules;
}

const DEFAULT_RULE: Rule = { type: "wildcard", value: "", length: 1 };

// List#find: the rules for each suffix of the name, an exception winning outright, else the longest.
function find(name: string): Rule {
  const parts = name.split(".").reverse();
  const matched: Rule[] = [];
  let query = parts[0]!;
  for (let index = 0; ; ) {
    const rule = list().get(query);
    if (rule) matched.push(rule);
    index += 1;
    if (index >= parts.length) break;
    query = `${parts[index]!}.${query}`;
  }
  if (matched.length === 0) return DEFAULT_RULE;
  let best = matched[0]!;
  for (const rule of matched.slice(1)) {
    if (rule.type === "exception") return rule;
    best = best.length > rule.length ? best : rule;
  }
  return best;
}

// Rule#decompose: [left, right] or [null, null]. The labels go into the pattern unescaped, as in Ruby.
function decompose(rule: Rule, domain: string): [string | null, string | null] {
  const parts = rule.type === "exception" ? rule.value.split(".").slice(1) : rule.value === "" ? [] : rule.value.split(".");
  const suffix = (rule.type === "wildcard" ? [".*?", ...parts] : parts).join("\\.");
  const match = new RegExp(`^(.*)\\.(${suffix})$`, "u").exec(domain);
  return match ? [match[1]!, match[2]!] : [null, null];
}

// String#strip, then chomp(".") and downcase.
function normalize(name: string): string | DomainInvalid {
  let what = name.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r \0]+$/gu, "");
  if (what.endsWith(".")) what = what.slice(0, -1);
  what = what.toLowerCase();
  if (what === "") return new DomainInvalid("Name is blank");
  if (what.startsWith(".")) return new DomainInvalid("Name starts with a dot");
  if (what.includes("://")) return new DomainInvalid(`${what} is not expected to contain a scheme`);
  return what;
}

export function isValidDomain(name: string): boolean {
  const what = normalize(name);
  if (what instanceof DomainInvalid) return false;
  return decompose(find(what), what)[1] !== null;
}

export function parseDomain(name: string): ParsedDomain {
  const what = normalize(name);
  if (what instanceof DomainInvalid) throw what;
  const rule = find(what);
  const [left, right] = decompose(rule, what);
  if (right === null) throw new DomainNotAllowed(`\`${what}\` is not allowed according to Registry policy`);
  // Ruby's split drops trailing empty fields, so "" gives no labels.
  const parts = left!.split(".");
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  const sld = parts.length === 0 ? null : parts.pop()!;
  const trd = parts.length === 0 ? null : parts.join(".");
  return { tld: right, sld, trd, domain: sld === null ? null : `${sld}.${right}` };
}
