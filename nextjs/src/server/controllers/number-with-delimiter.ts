// ActionView's number_with_delimiter for the strings Redis holds (HomePageNumbersController). Golden:
// __fixtures__/number-with-delimiter.golden.json (scripts/golden/number-with-delimiter.rb).
import { NotPortedError } from "../models/user.ts";

const SOURCE = "home_page_numbers_controller.rb";
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/u;
// Spellings Ruby's Float() may or may not read (padding, underscores, exponents, hex, a bare dot): not worth guessing at.
const MAYBE_A_FLOAT = /^[\s+\-._\dxXa-fA-F]*$/u;
const THOUSANDS = /(\d)(?=(\d\d\d)+(?!\d))/gu;

export function numberWithDelimiter(value: string | null): string {
  if (value === null || value === "") return "";
  if (PLAIN_NUMBER.test(value)) {
    const [integer = "", fraction] = value.split(".");
    const grouped = integer.replace(THOUSANDS, "$1,");
    return fraction === undefined ? grouped : `${grouped}.${fraction}`;
  }
  // Float() raises for anything else, and the helper hands the value back unchanged.
  if (MAYBE_A_FLOAT.test(value)) throw new NotPortedError(`a payout figure Ruby's Float() might read (${JSON.stringify(value)})`, SOURCE);
  return value;
}
