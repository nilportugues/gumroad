// Ai::CustomHtmlSnippetMatcher. The exact pass runs first and is the only one consulted when it
// matches. The tolerant pass generalizes whitespace runs in the snippet to any non-empty run in the
// page, so it changes how forgivingly the snippet is found, never what gets replaced.
// Both edit endpoints must match through here, or a previewed proposal can fail on apply.

export type SnippetMatch = {
  occurrences: number;
  // What to hand to String#replace: the literal snippet for an exact match, otherwise the tolerant RegExp.
  matcher: string | RegExp;
};

// Ruby's [[:space:]] is Unicode White_Space, i.e. \p{White_Space} (JS \s also takes U+FEFF).
const WHITESPACE_RUN_SOURCE = String.raw`(?:[\p{White_Space}]|&nbsp;)+`;
const WHITESPACE_RUN_ONLY = new RegExp(`^${WHITESPACE_RUN_SOURCE}$`, "u");
const WHITESPACE_SPLIT = new RegExp(`(${WHITESPACE_RUN_SOURCE})`, "u");

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");

// String#scan(literal).size: non-overlapping occurrences.
export function countLiteral(page: string, find: string): number {
  if (find.length === 0) return page.length + 1;
  let count = 0;
  for (let at = page.indexOf(find); at !== -1; at = page.indexOf(find, at + find.length)) count += 1;
  return count;
}

export function whitespaceTolerantPattern(find: string): RegExp {
  const segments = find
    .split(WHITESPACE_SPLIT)
    .map((segment) => (WHITESPACE_RUN_ONLY.test(segment) ? WHITESPACE_RUN_SOURCE : escapeRegExp(segment)));
  return new RegExp(segments.join(""), "gu");
}

export function matchCustomHtmlSnippet(page: string, find: string): SnippetMatch {
  const exactOccurrences = countLiteral(page, find);
  if (exactOccurrences > 0) return { occurrences: exactOccurrences, matcher: find };

  const pattern = whitespaceTolerantPattern(find);
  return { occurrences: Array.from(page.matchAll(pattern)).length, matcher: pattern };
}
