// Request bodies as EsClient serializes them: MultiJson's json_gem adapter calls `to_json({})`,
// which ActiveSupport routes through ActiveSupport::JSON.encode, so `<`, `>`, `&`, U+2028 and
// U+2029 come out as \uXXXX (escape_html_entities_in_json, the Rails default) and Floats keep
// their `.0`. Documents reach here already `as_json`ed: times are ISO strings (time_precision 0),
// Floats are RubyFloat.
import { dumpRubyJson, type JsonValue, RubyFloat } from "../jobs/sidekiq/ruby-json.ts";

export { RubyFloat };
export type { JsonValue };

const HTML_UNSAFE = /[<>&\u2028\u2029]/gu;

export function esJson(value: JsonValue): string {
  return escapeHtmlInJson(dumpRubyJson(value));
}

// ActiveSupport's escape_html_entities_in_json applied to already-encoded JSON (the characters only occur inside strings).
export function escapeHtmlInJson(encoded: string): string {
  return encoded.replace(HTML_UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Time#as_json under ActiveSupport::JSON::Encoding.time_precision = 0 (json_time_precision.rb),
// for a UTC time: "2025-11-01T00:00:00Z".
export function timeAsJson(time: Date | null | undefined): string | null {
  if (!time) return null;
  return `${time.toISOString().slice(0, 19)}Z`;
}
