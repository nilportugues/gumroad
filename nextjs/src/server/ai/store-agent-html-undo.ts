// Ai::StoreAgentHtmlUndo.receipt: the inverse of a saved custom-HTML splice, recorded only when
// reverting it provably restores the page. `latest_for` (the SQL lookup of the last applied change)
// is not ported here: it reads AiMessage rows and their JSON metadata.
import { createHash } from "node:crypto";

import { countLiteral, matchCustomHtmlSnippet } from "./custom-html-snippet-matcher.ts";

const HTML_UNDO_ENDPOINTS: readonly string[] = ["edit_user_custom_html", "edit_product_custom_html"];

// Ruby's String#present?: not empty and not only whitespace.
const isPresentString = (value: unknown): value is string =>
  typeof value === "string" && !/^[\p{White_Space}]*$/u.test(value);

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// String#[] with a String or Regexp argument: the text the matcher selects (first occurrence).
function selectedText(page: string, matcher: string | RegExp): string {
  if (typeof matcher === "string") return matcher;
  const firstOnly = new RegExp(matcher.source, matcher.flags.replace("g", ""));
  return page.match(firstOnly)?.[0] ?? "";
}

// String#sub(matcher) { replacement }, first occurrence only, with the replacement inserted literally.
function substitute(page: string, matcher: string | RegExp, replacement: string): string {
  return page.replace(matcher, () => replacement);
}

export type HtmlUndoReceipt = {
  endpoint: string;
  path_params: Record<string, unknown>;
  params: {
    find: string;
    replace: string;
    expected_custom_html_sha256: string;
    result_custom_html_sha256: string;
  };
};

export function htmlUndoReceipt(input: {
  endpoint: string;
  pathParams: Record<string, unknown>;
  body: { find?: unknown; replace?: unknown };
  response: { success?: unknown; previous_custom_html?: unknown; custom_html?: unknown };
}): HtmlUndoReceipt | null {
  const { endpoint, pathParams, body, response } = input;
  if (!HTML_UNDO_ENDPOINTS.includes(endpoint) || response.success !== true) return null;

  const { previous_custom_html: beforeHtml, custom_html: afterHtml } = response;
  const { find, replace } = body;
  if (
    !isPresentString(beforeHtml) ||
    !isPresentString(afterHtml) ||
    !isPresentString(find) ||
    !isPresentString(replace)
  )
    return null;
  if (beforeHtml === afterHtml || countLiteral(afterHtml, replace) !== 1) return null;

  const match = matchCustomHtmlSnippet(beforeHtml, find);
  if (match.occurrences !== 1 || substitute(beforeHtml, match.matcher, replace) !== afterHtml) return null;
  if (substitute(afterHtml, replace, selectedText(beforeHtml, match.matcher)) !== beforeHtml) return null;

  return {
    endpoint,
    path_params: pathParams,
    params: {
      find: replace,
      replace: selectedText(beforeHtml, match.matcher),
      expected_custom_html_sha256: sha256Hex(afterHtml),
      result_custom_html_sha256: sha256Hex(beforeHtml),
    },
  };
}
