import type { CookieSource } from "./resolve";

// Rack percent-encodes cookie values; the first occurrence of a name wins, as in Rack.
export function cookiesFromHeader(header: string | null): CookieSource {
  const values = new Map<string, string>();
  for (const pair of (header ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (values.has(name)) continue;
    const raw = pair.slice(separator + 1).trim();
    try {
      values.set(name, decodeURIComponent(raw));
    } catch {
      values.set(name, raw);
    }
  }
  return { get: (name) => values.get(name) };
}
