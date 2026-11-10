// PoBoxAddress (app/services/po_box_address.rb).
import { isBlank } from "./compliance-countries.ts";

const EXPLICIT = "pobox";
// `i` without `u`: Ruby's /i on an ASCII class folds nothing outside ASCII, which `iu` would (U+212A reads as "k").
// eslint-disable-next-line require-unicode-regexp
const SPELLED_OUT = /post[^a-z0-9]*office[^a-z0-9]*box(?![a-z])/i;
// Ruby's `\b` is Unicode-aware while `\s` and `\d` are ASCII-only; JS has them the other way round.
const BARE_BOX_AND_NUMBER = /(?<![\p{L}\p{M}\p{N}\p{Pc}])box[ \t\n\v\f\r]*[#.]?[ \t\n\v\f\r]*\d/iu;

// PoBoxAddress::POSSIBLE_MATCH_SQL_HINT
export const POSSIBLE_MATCH_SQL_HINT = "%b%o%x%";

// PoBoxAddress.match?
export function isPoBoxMatch(address: string | null | undefined): address is string {
  if (address == null || isBlank(address)) return false;
  return address.replace(/[^\w]/gu, "").toLowerCase().includes(EXPLICIT) || SPELLED_OUT.test(address);
}

// PoBoxAddress.possible_match?
export function isPossiblePoBoxMatch(address: string | null | undefined): boolean {
  if (address == null || isBlank(address)) return false;
  return isPoBoxMatch(address) || BARE_BOX_AND_NUMBER.test(address);
}
