// Port of app/services/content_moderation/strategies/blocklist_strategy.rb.
// The YAML and GlobalConfig reads stay with the caller; this takes the words it loaded.

export type BlocklistResult = { status: "flagged" | "compliant"; reasoning: string[] };

// Ruby's \w under a UTF-8 regex: letters, marks, decimal digits and connector punctuation.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";
const WORD_CHAR_RE = /[\p{L}\p{M}\p{Nd}\p{Pc}]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Ruby's \b is "word-ness changes here". JS's \b is ASCII-only, so the boundary is spelled out
// with lookarounds. The side that is a word character gets a negative lookaround, the other a
// positive one, matching what \b would require at that edge of the literal.
function wordBoundedPattern(word: string): RegExp {
  const first = word.charAt(0);
  const last = word.charAt(word.length - 1);
  const start = WORD_CHAR_RE.test(first) ? `(?<!${WORD_CHAR})` : `(?<=${WORD_CHAR})`;
  const end = WORD_CHAR_RE.test(last) ? `(?!${WORD_CHAR})` : `(?=${WORD_CHAR})`;
  return new RegExp(`${start}${escapeRegExp(word)}${end}`, "u");
}

// `(yaml + env).map(&:downcase).uniq.reject(&:empty?)`. `env` is the raw CONTENT_MODERATION_BLOCKLIST
// value, comma separated.
export function blocklistWords(yamlWords: readonly string[], envValue: string): string[] {
  const envWords = envValue.split(",").map((word) => word.trim());
  const all = [...yamlWords, ...envWords].map((word) => word.toLowerCase());
  return [...new Set(all)].filter((word) => word.length > 0);
}

export function performBlocklist(text: string, words: readonly string[]): BlocklistResult {
  if (words.length === 0) return { status: "compliant", reasoning: [] };

  const downcased = text.toLowerCase();
  const matched = words.filter((word) => wordBoundedPattern(word).test(downcased));
  if (matched.length === 0) return { status: "compliant", reasoning: [] };

  return { status: "flagged", reasoning: matched.map((word) => `Matched blocked word: ${word}`) };
}
