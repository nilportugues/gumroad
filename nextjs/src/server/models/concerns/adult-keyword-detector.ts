// Port of app/services/adult_keyword_detector.rb.
const ADULT_KEYWORDS = [
  "futa", "pussy", "bondage", "bdsm", "lewd", "ahegao", "nude", "milking", "topless", "lolita", "lewds",
  "creampie", "dildo", "gape", "semen", "cuckold", "hairjob", "tickling", "hogtied", "uncensored", "thong",
  "pinup", "impregnation", "gagged", "hentai", "squirt", "orgasm", "virginkiller", "abdl", "crotch",
  "breast inflation", "granblue", "lingerie",
  "boudoir", "kink", "shibari", "gutpunch", "gutpunching", "abs punch", "necro",
  "vibrator", "fetish", "nsfw", "footjob", "joi",
];

// Ruby's \b on a UTF-8 string treats every Unicode word character as a word character; JS's \b
// only knows ASCII ones, so "élewd" would match here and not in Ruby.
const WORD = String.raw`[\p{L}\p{M}\p{Nd}\p{Pc}]`;
const ADULT_KEYWORD_REGEX = new RegExp(`(?<!${WORD})(${ADULT_KEYWORDS.join("|")})(?!${WORD})`, "u");

const TOKENIZATION_REGEX = /(?:[\p{Lu}\p{Lt}]?[\p{Ll}\p{Lm}\p{Lo}]+)|(?:[\p{Lu}\p{Lt}])+/gu;
const NOT_LETTER_OR_SPACE_REGEX = /[^\p{Lu}\p{Lt}\p{Ll}\p{Lm}\p{Lo} ]/gu;

// `text.present?`
const isPresent = (text: string | null | undefined): text is string => text != null && /[^\s]/u.test(text);

export function isAdult(text: string | null | undefined): boolean {
  const tokens = isPresent(text) ? (text.replace(NOT_LETTER_OR_SPACE_REGEX, " ").match(TOKENIZATION_REGEX) ?? []).map((t) => t.toLowerCase()) : [];
  return ADULT_KEYWORD_REGEX.test(tokens.join(" "));
}
