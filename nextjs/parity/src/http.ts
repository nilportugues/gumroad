import {
  json as canonicalJson,
  cookieValue,
  type Json,
  parseJson,
  string as canonicalString,
  timeToken,
} from "./canonical";
import type { CapturedHttp, CapturedResponse, FixtureRequest } from "./fixture";

// Keep in sync with VOLATILE_RESPONSE_HEADERS in spec/support/parity/recorder.rb.
export const VOLATILE_RESPONSE_HEADERS = new Set([
  "date",
  "etag",
  "content-length",
  "x-request-id",
  "x-runtime",
  "server-timing",
  "set-cookie",
  "content-security-policy",
  "content-security-policy-report-only",
]);

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export function buildRequest(request: FixtureRequest): Request {
  const host = request.headers.host ?? "localhost";
  const url = `http://${host}${request.path}${request.query ? `?${request.query}` : ""}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name !== "host" && name !== "content-length") headers.set(name, value);
  }
  if (request.cookies) {
    headers.set(
      "cookie",
      Object.entries(request.cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    );
  }
  const body = BODYLESS_METHODS.has(request.method)
    ? undefined
    : request.bodyBase64 !== undefined
      ? Buffer.from(request.bodyBase64, "base64")
      : request.body;
  return new Request(url, { method: request.method, headers, body });
}

// `bodyNow` is the instant the body's times are measured from when the rows were seeded against another clock than the server's.
export async function captureResponse(response: Response, now: Date, bodyNow = now): Promise<CapturedResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "location" && !VOLATILE_RESPONSE_HEADERS.has(name)) headers[name] = value;
  });
  const sorted = Object.fromEntries(Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const captured: CapturedResponse = {
    status: response.status,
    headers: canonicalJson(sorted, now) as Record<string, Json>,
  };
  const location = response.headers.get("location");
  if (location) captured.location = location;
  const cookies = setCookies(response.headers.getSetCookie(), now);
  if (Object.keys(cookies).length) captured.cookies = cookies;
  return { ...captured, ...(await responseBody(response, bodyNow)) };
}

export function setCookies(lines: string[], now: Date): Record<string, Record<string, Json>> {
  const out: Record<string, Record<string, Json>> = {};
  for (const line of [...lines].sort()) {
    const [pair = "", ...attributes] = line.split(/;\s*/u);
    const [name = "", value = ""] = splitOnce(pair, "=");
    const parsed: Record<string, Json> = { value: cookieValue(name, safeDecode(value)) };
    for (const attribute of attributes) {
      const [rawKey = "", attrValue] = splitOnce(attribute, "=");
      const key = rawKey.toLowerCase();
      if (attrValue === undefined) parsed[key] = true;
      else if (key === "expires") parsed[key] = expiresToken(attrValue, now);
      else parsed[key] = attrValue;
    }
    out[name] = parsed;
  }
  return out;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator);
  return index === -1 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)];
}

// Ruby's CGI.unescape: "+" is a space.
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

function expiresToken(value: string, now: Date): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : timeToken(time, now);
}

async function responseBody(response: Response, now: Date): Promise<Partial<CapturedResponse>> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) return {};
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { bodyBase64: Buffer.from(bytes).toString("base64") };
  }
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("json")) return { json: canonicalJson(parseJson(text), now) };
    if (contentType.includes("html")) {
      const page = inertiaPage(text);
      if (page !== undefined) return { inertia: canonicalJson(page, now) };
    }
  } catch {
    // Unparseable JSON is compared as text, as the recorder does.
  }
  return { body: canonicalString(text, now) };
}

// Same extraction as Recorder#inertia_page: the props are the contract, the layout is not.
export function inertiaPage(html: string): Json | undefined {
  const script = /<script[^>]*data-page="[^"]*"[^>]*>([\s\S]*?)<\/script>/u.exec(html);
  if (script?.[1] !== undefined) return parseJson(script[1]);
  const attribute = /\sdata-page="([^"]*)"/u.exec(html);
  if (attribute?.[1] !== undefined) return parseJson(unescapeHtml(attribute[1]));
  return undefined;
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export type FetchInterceptor = { calls: () => CapturedHttp[]; restore: () => void };

// Serves the port the responses Rails got (the fixture is the cassette) and records what the
// port sent. Only sees calls made in this process, so it does nothing for httpTransport.
export function interceptFetch(recorded: CapturedHttp[], now: Date): FetchInterceptor {
  const original = globalThis.fetch;
  const unused = [...recorded];
  const calls: CapturedHttp[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.body ? await request.text() : undefined;
    const contentType = request.headers.get("content-type") ?? undefined;
    const call: CapturedHttp = { method: request.method, url: request.url, response: {} };
    if (contentType) call.contentType = contentType;
    if (body) call.body = body;
    calls.push(canonicalJson(call, now) as unknown as CapturedHttp);

    const index = unused.findIndex((candidate) => candidate.method === call.method && candidate.url === call.url);
    if (index === -1)
      return new Response(`parity: no recorded response for ${call.method} ${call.url}`, { status: 599 });
    const [match] = unused.splice(index, 1);
    const headers = match!.response.contentType ? { "content-type": match!.response.contentType } : undefined;
    return new Response(match!.response.body ?? "", { status: match!.response.status ?? 200, headers });
  };

  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
