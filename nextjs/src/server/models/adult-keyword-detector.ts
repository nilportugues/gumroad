// app/services/adult_keyword_detector.rb
import { isBlank } from "./runtime/validators.ts";

const ADULT_KEYWORDS = [
  "futa",
  "pussy",
  "bondage",
  "bdsm",
  "lewd",
  "ahegao",
  "nude",
  "milking",
  "topless",
  "lolita",
  "lewds",
  "creampie",
  "dildo",
  "gape",
  "semen",
  "cuckold",
  "hairjob",
  "tickling",
  "hogtied",
  "uncensored",
  "thong",
  "pinup",
  "impregnation",
  "gagged",
  "hentai",
  "squirt",
  "orgasm",
  "virginkiller",
  "abdl",
  "crotch",
  "breast inflation",
  "granblue",
  "lingerie",
  "boudoir",
  "kink",
  "shibari",
  "gutpunch",
  "gutpunching",
  "abs punch",
  "necro",
  "vibrator",
  "fetish",
  "nsfw",
  "footjob",
  "joi",
];

// Ruby's \b is Unicode-aware, JavaScript's is ASCII-only, so the boundary is spelled out with Ruby's \w.
const WORD = "[\\p{L}\\p{M}\\p{N}\\p{Pc}]";
const ADULT_KEYWORD_REGEX = new RegExp(`(?<!${WORD})(${ADULT_KEYWORDS.join("|")})(?!${WORD})`, "u");
const NOT_LETTER_OR_SPACE = /[^\p{Lu}\p{Lt}\p{Ll}\p{Lm}\p{Lo} ]/gu;
const TOKENIZATION = /(?:[\p{Lu}\p{Lt}]?[\p{Ll}\p{Lm}\p{Lo}]+)|(?:[\p{Lu}\p{Lt}])+/gu;

// AdultKeywordDetector.adult?
export function isAdult(text: string | null): boolean {
  if (text === null || isBlank(text)) return false;
  const tokens = (text.replace(NOT_LETTER_OR_SPACE, " ").match(TOKENIZATION) ?? []).map((token) => token.toLowerCase());
  return ADULT_KEYWORD_REGEX.test(tokens.join(" "));
}
