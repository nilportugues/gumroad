// Set-Cookie lines as Rack 3.2's Utils.set_cookie_header writes them, and the request-side reads
// ActionDispatch's cookie jar does.

export type RackCookie = {
  value: string;
  domain?: string;
  path?: string;
  expires?: Date;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
};

// URI.encode_www_form_component: unreserved are *-._ and alphanumerics; space becomes "+".
export function rackEscape(value: string): string {
  return Array.from(Buffer.from(value, "utf8"))
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[*\-._0-9A-Za-z]/.test(char)) return char;
      if (char === " ") return "+";
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export function setCookieHeader(name: string, cookie: RackCookie): string {
  let line = `${rackEscape(name)}=${rackEscape(cookie.value)}`;
  if (cookie.domain) line += `; domain=${cookie.domain}`;
  if (cookie.path) line += `; path=${cookie.path}`;
  if (cookie.expires) line += `; expires=${cookie.expires.toUTCString()}`;
  if (cookie.secure) line += "; secure";
  if (cookie.httpOnly) line += "; httponly";
  if (cookie.sameSite) line += `; samesite=${cookie.sameSite}`;
  return line;
}

// Rack::Utils.parse_cookies_header: the first value of a repeated name wins, names stay escaped,
// values are unescaped ("+" is a space), and a pair without "=" reads as nil.
export function requestCookies(header: string | null): Map<string, string | null> {
  const cookies = new Map<string, string | null>();
  for (const pair of (header ?? "").split(/; */)) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const name = index === -1 ? pair : pair.slice(0, index);
    if (!cookies.has(name)) cookies.set(name, index === -1 ? null : unescape(pair.slice(index + 1)));
  }
  return cookies;
}

function unescape(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}
