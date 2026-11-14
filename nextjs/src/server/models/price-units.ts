import { isCurrencyTypeSingleUnit } from "./concerns/currency-helper.ts";

// LinksController::PRICE_INPUT_MAX_LENGTH and PRICE_INPUT_PATTERN (the signed forms are left to Rails)
const PRICE_INPUT_MAX_LENGTH = 64;
const PRICE_INPUT_PATTERN = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/u;
// BasePrice::Shared::MAX_PRICE_CENTS
const MAX_PRICE_CENTS = 2_147_483_647n;

// LinksController#price_cents_from_units: `BigDecimal(value) * scaling_factor`, rounded half up, within 0..MAX_PRICE_CENTS. Null is
// Rails' nil (an invalid amount); "unsupported" is an input whose BigDecimal reading the port does not reproduce (a sign).
export function priceCentsFromUnits(value: string, currencyType: string | null): number | null | "unsupported" {
  if (currencyType === null) return "unsupported";
  if (value.length > PRICE_INPUT_MAX_LENGTH) return null;
  const match = PRICE_INPUT_PATTERN.exec(value);
  if (!match) return /^[+-]/u.test(value) ? "unsupported" : null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  const decimals = isCurrencyTypeSingleUnit(currencyType) ? 0 : 2;
  const padded = fraction.padEnd(decimals + 1, "0");
  let cents = BigInt(whole + padded.slice(0, decimals));
  if (padded.charCodeAt(decimals) >= "5".charCodeAt(0)) cents += 1n;
  return cents <= MAX_PRICE_CENTS ? Number(cents) : null;
}
