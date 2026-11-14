// Ruby semantics the moderation code relies on, so the ports read the same as the Ruby they mirror.

// String#split with a literal separator: trailing empty fields are dropped.
export function rubySplit(value: string, separator: string): string[] {
  const parts = value.split(separator);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// String#strip: whitespace and NUL.
export function rubyStrip(value: string): string {
  return value.replace(/^[\s\0]+|[\s\0]+$/gu, "");
}

// Only nil and false are falsy.
export function isRubyTruthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

// to_s for JSON values: nil becomes "", strings pass through.
export function rubyToS(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
