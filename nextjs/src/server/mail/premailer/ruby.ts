// Ruby String semantics the premailer port depends on. Ruby's \s is ASCII whitespace only, `^`/`$`
// anchor at "\n" only, and String#split drops trailing empty fields; JavaScript differs on all three.

// Ruby's \s: [ \t\r\n\f\v].
export const WS = "[ \\t\\n\\v\\f\\r]";
// Ruby's ^ and $ (line anchors on "\n" only).
export const BOL = "(?:(?<![\\s\\S])|(?<=\\n))";
export const EOL = "(?=\\n|(?![\\s\\S]))";
// Ruby's \Z: end of string, or before a final "\n".
export const END_Z = "(?=\\n?(?![\\s\\S]))";

// String#strip: whitespace and NUL at both ends.
export function strip(value: string): string {
  return value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");
}

// String#split(pattern) without a limit: trailing empty fields are removed. A leading empty field
// is kept, except that an empty string splits to [].
export function split(value: string, separator: string | RegExp): string[] {
  if (value === "") return [];
  const parts = value.split(separator);
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

// String#slice!(regexp): removes and returns the first match, or null.
export function sliceBang(holder: { value: string }, pattern: RegExp): string | null {
  const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const match = re.exec(holder.value);
  if (!match) return null;
  holder.value = holder.value.slice(0, match.index) + holder.value.slice(match.index + match[0].length);
  return match[0];
}

// String#scan(regexp).length for a pattern without groups.
export function scanCount(value: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  for (const match of value.matchAll(re)) {
    if (match[0] !== "" || match.index !== undefined) count++;
  }
  return count;
}

export function isAsciiOnly(value: string): boolean {
  return /^[\x00-\x7F]*$/u.test(value);
}

export function utf8Bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}
