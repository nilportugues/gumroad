// What the Ruby integrations clients get from HTTParty and URI for free: the parsed body of a response, `present?`, `dig`, and the two
// query encoders (form encoding for a POST body, ERB::Util.url_encode for a GET query).
import { outboundFetch } from "../infra/outbound-http.ts";

const HTTP_SUCCESS_MINIMUM = 200;
const HTTP_SUCCESS_LIMIT = 300;

export type ParsedResponse = { status: number; ok: boolean; parsed: unknown };

export const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// ActiveSupport's Object#present? for a value read out of JSON.
export function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return !/^\s*$/u.test(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isHash(value)) return Object.keys(value).length > 0;
  return true;
}

// HTTParty's parsed_response: JSON for a JSON content type, the raw string otherwise, nil for an empty body.
export async function parseHttpParty(response: Response): Promise<ParsedResponse> {
  const ok = response.status >= HTTP_SUCCESS_MINIMUM && response.status < HTTP_SUCCESS_LIMIT;
  const text = await response.text();
  if (text.trim() === "") return { status: response.status, ok, parsed: null };
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json"))
    return { status: response.status, ok, parsed: text };
  try {
    return { status: response.status, ok, parsed: JSON.parse(text) as unknown };
  } catch {
    // HTTParty raises its ParseError, which Rails turns into a 500.
    throw new Error("The provider answered JSON that does not parse");
  }
}

// `parsed_response&.dig(key)`, which raises on anything but a hash or nil.
export function digParsed(parsed: unknown, key: string): unknown {
  if (parsed === null) return undefined;
  if (!isHash(parsed)) throw new Error("The provider answered a body that is not a JSON object");
  return parsed[key];
}

// URI.encode_www_form_component
function formComponent(value: string): string {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

// URI.encode_www_form: a nil value is a bare key.
export function encodeWwwForm(fields: [string, string | null | undefined][]): string {
  return fields
    .map(([key, value]) =>
      value === null || value === undefined ? formComponent(key) : `${formComponent(key)}=${formComponent(value)}`,
    )
    .join("&");
}

// ERB::Util.url_encode, which HTTParty uses for a `query:` hash: only `-_.~` and alphanumerics stay as they are.
export function urlEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

// HTTParty.post(url, body: URI.encode_www_form(...)): Net::HTTP sends a string body as a form.
export function postForm(
  url: string,
  fields: [string, string | null | undefined][],
  headers: Record<string, string> = {},
) {
  return outboundFetch(url, {
    method: "POST",
    body: encodeWwwForm(fields),
    headers: { "Content-Type": FORM_CONTENT_TYPE, ...headers },
  });
}
