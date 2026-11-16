// `page.to_json` as ActiveSupport encodes it (escape_html_entities_in_json is on): the same JSON as
// JSON.stringify, with <, > and & and the JS line separators written as \u escapes so it is safe
// inside an HTML document.
const ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export const railsJson = (value: unknown): string => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (char) => ESCAPES[char]!);
