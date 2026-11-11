import type { CapturedExchange, Exchange } from "./fixture";

export type Difference = {
  path: string;
  kind: "changed" | "missing" | "unexpected";
  expected?: unknown;
  actual?: unknown;
};

export type CompareOptions = {
  // Paths to skip, dot-separated; `*` matches one segment, `prefix*` a segment starting with it, `**` any number. Array indexes are
  // segments too: "db.users.inserted.*.confirmation_token".
  ignore?: string[];
  // Paths whose objects may carry extra keys on the port's side.
  subset?: string[];
};

// Next.js and Rails add framework headers of their own; only the ones Rails sent must match.
export const DEFAULT_SUBSET = ["response.headers"];

const CHANNELS = ["response", "db", "jobs", "mails", "http"] as const;

export function compareExchange(
  expected: Exchange,
  actual: CapturedExchange,
  options: CompareOptions & { sessionCookie?: string } = {},
): Difference[] {
  const ignore = [...(options.ignore ?? [])].map(splitPattern);
  // The session cookie is encrypted with a random IV, so only its presence and attributes compare.
  if (options.sessionCookie) ignore.push(["response", "cookies", options.sessionCookie, "value"]);
  const subset = [...DEFAULT_SUBSET, ...(options.subset ?? [])].map(splitPattern);
  const differences: Difference[] = [];
  for (const channel of CHANNELS) {
    const want = channel === "http" ? expected.http.map(({ response: _, ...call }) => call) : expected[channel];
    const got = channel === "http" ? actual.http.map(({ response: _, ...call }) => call) : actual[channel];
    walk([channel], want, got, { ignore, subset }, differences);
  }
  return differences;
}

type Patterns = { ignore: string[][]; subset: string[][] };

function walk(path: string[], expected: unknown, actual: unknown, patterns: Patterns, out: Difference[]): void {
  if (patterns.ignore.some((pattern) => matches(pattern, path))) return;
  // The recorder drops nil values, so an absent key and null are the same thing.
  const want = expected ?? null;
  const got = actual ?? null;

  if (Array.isArray(want) && Array.isArray(got)) {
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const itemPath = [...path, String(i)];
      if (i >= got.length) out.push({ path: format(itemPath), kind: "missing", expected: want[i] });
      else if (i >= want.length) out.push({ path: format(itemPath), kind: "unexpected", actual: got[i] });
      else walk(itemPath, want[i], got[i], patterns, out);
    }
    return;
  }

  if (isObject(want) && isObject(got)) {
    const subset = patterns.subset.some((pattern) => matches(pattern, path));
    const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])];
    for (const key of keys) {
      const keyPath = [...path, key];
      const inWant = want[key] !== undefined && want[key] !== null;
      const inGot = got[key] !== undefined && got[key] !== null;
      if (inWant && !inGot) {
        if (!patterns.ignore.some((pattern) => matches(pattern, keyPath)))
          out.push({ path: format(keyPath), kind: "missing", expected: want[key] });
      } else if (!inWant && inGot) {
        if (!subset && !patterns.ignore.some((pattern) => matches(pattern, keyPath)))
          out.push({ path: format(keyPath), kind: "unexpected", actual: got[key] });
      } else if (inWant && inGot) {
        walk(keyPath, want[key], got[key], patterns, out);
      }
    }
    return;
  }

  if (!Object.is(want, got)) out.push({ path: format(path), kind: "changed", expected: want, actual: got });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitPattern(pattern: string): string[] {
  return pattern.split(".");
}

function matches(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") return path.some((_, i) => matches(rest, path.slice(i))) || matches(rest, []);
  if (path.length === 0) return false;
  // `name_*` matches a segment by prefix: a cookie whose name carries a random id.
  const segment = path[0]!;
  const segmentMatches = head === "*" || head === segment || (head!.length > 1 && head!.endsWith("*") && segment.startsWith(head!.slice(0, -1)));
  return segmentMatches && matches(rest, path.slice(1));
}

function format(path: string[]): string {
  return path
    .map((segment, i) => (/^\d+$/u.test(segment) ? `[${segment}]` : i === 0 ? segment : `.${segment}`))
    .join("");
}

const MAX_VALUE_LENGTH = 300;

function show(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 0);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}...` : text;
}

export function formatDifferences(differences: Difference[]): string {
  return differences
    .map((difference) => {
      switch (difference.kind) {
        case "changed":
          return `${difference.path}\n    rails: ${show(difference.expected)}\n    next:  ${show(difference.actual)}`;
        case "missing":
          return `${difference.path}  missing in next\n    rails: ${show(difference.expected)}`;
        case "unexpected":
          return `${difference.path}  only in next\n    next:  ${show(difference.actual)}`;
      }
    })
    .join("\n");
}
