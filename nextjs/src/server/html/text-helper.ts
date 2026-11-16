// ActionView::Helpers::TextHelper (actionview 8.1) as the mailer views call it.
import { sanitize } from "./sanitizer.ts";

// String#blank?: [[:space:]] is Unicode White_Space.
const BLANK = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
export const isBlank = (value: string | null | undefined): boolean => value == null || BLANK.test(value);

// simple_format(text) with no options: sanitized, split into <p> paragraphs, single newlines as <br />.
export function simpleFormat(text: string | null): string {
  const sanitized = text === null ? null : sanitize(text);
  const paragraphs = splitParagraphs(sanitized);
  if (paragraphs.length === 0) return "<p></p>";
  return paragraphs.map((p) => `<p>${p}</p>`).join("\n\n");
}

function splitParagraphs(text: string | null): string[] {
  if (isBlank(text)) return [];
  const parts = text!.replace(/\r\n?/gu, "\n").split(/\n\n+/u);
  // String#split drops trailing empty fields.
  while (parts.at(-1) === "") parts.pop();
  return parts.map((t) => t.replace(/([^\n]\n)(?=[^\n])/gu, "$1<br />"));
}
