import { describe, expect, it } from "vitest";

import { escapeHtmlInJson } from "./es-json.ts";

describe("escapeHtmlInJson", () => {
  // ActiveSupport::JSON.encode({ "a" => "<b>&" + U+2028 + U+2029 }) under escape_html_entities_in_json, Rails' default.
  it("writes <, >, & and the line separators as unicode escapes", () => {
    expect(escapeHtmlInJson(JSON.stringify({ a: "<b>&  " }))).toBe('{"a":"\\u003cb\\u003e\\u0026\\u2028\\u2029"}');
  });
});
