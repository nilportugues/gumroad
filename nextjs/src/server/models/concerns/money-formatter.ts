// Port of app/modules/money_formatter.rb over the `money` gem (6.19) as config/initializers/money.rb
// configures it (HALF_UP, I18n locale backend, KRW and HUF at 100 subunits), and of the two formatters
// built on it that receipts use: CurrencyHelper#formatted_amount_in_currency and
// StripeChargeProcessor.format_charge_presentment_amount.
//
// The currency table (symbol, symbol position, subunits, `format`) is read from the gem by
// scripts/golden/money-format.rb into money-currencies.generated.json; the same script records
// __fixtures__/money-format.golden.json, which money-formatter.test.ts replays for every currency the
// gem knows, a grid of amounts (negative, fractional, nil) and the unknown codes that soft-fail to the ISO code.
import { Prisma } from "@prisma/client";

import DATA from "../money-currencies.generated.json" with { type: "json" };

type CurrencyData = {
  iso_code: string;
  symbol: string | null;
  symbol_first: boolean;
  subunit_to_unit: number;
  decimal_places: number;
  format: string | null;
  i18n_symbol: string | null;
};

const CURRENCIES = DATA.currencies as Record<string, CurrencyData>;
const CHOICES_SYMBOLS = DATA.choices_symbols as Record<string, string>;
const ZERO_DECIMAL_CHARGE_CURRENCIES = new Set<string>(DATA.zero_decimal_charge_currencies);
const DELIMITER = DATA.i18n.delimiter;
const SEPARATOR = DATA.i18n.separator;

// 60 digits is far past any amount the formatter sees, so division and rounding see the same digits as BigDecimal.
const D = Prisma.Decimal.clone({ precision: 60, rounding: Prisma.Decimal.ROUND_HALF_UP });

export class UnknownCurrency extends Error {
  readonly rubyClass = "Money::Currency::UnknownCurrency";
  constructor(code: string) {
    super(`Unknown currency '${code}'`);
  }
}

// An amount as `Money.new` takes it: an Integer, a Float (read through its shortest decimal form, as
// Float#to_d does) or nil.
export type MoneyAmount = number | bigint | Prisma.Decimal | null | undefined;

// Money::Currency.new(code)
export function findCurrency(code: string): CurrencyData {
  const currency = Object.hasOwn(CURRENCIES, code.toLowerCase()) ? CURRENCIES[code.toLowerCase()] : undefined;
  if (!currency) throw new UnknownCurrency(code);
  return currency;
}

// CurrencyHelper#subunit_to_unit
export const subunitToUnit = (currencyType: string): number => findCurrency(currencyType.toLowerCase()).subunit_to_unit;

// Money#fractional: HALF_UP to a whole number of subunits.
function fractionalOf(amount: MoneyAmount): Prisma.Decimal {
  if (amount === null || amount === undefined) return new D(0);
  const value = typeof amount === "number" ? new D(String(amount)) : new D(amount.toString());
  return value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
}

export type MoneyFormatOptions = { noCentsIfWhole?: boolean; withCurrency?: boolean };

// Money#format with `symbol:` already resolved: a string, or null/"" for no symbol.
function formatMoney(amount: MoneyAmount, currency: CurrencyData, code: string, symbol: string | null, options: MoneyFormatOptions): string {
  const fractional = fractionalOf(amount);
  const negative = fractional.isNegative() && !fractional.isZero();
  const [whole = "0", decimal = "0"] = fractional.abs().div(currency.subunit_to_unit).toFixed().split(".");

  let decimalPart: string | null = decimal;
  if (currency.decimal_places === 0 || (options.noCentsIfWhole && Number.parseInt(decimal, 10) === 0)) decimalPart = null;
  else decimalPart = decimal.padEnd(currency.decimal_places, "0") || null;

  const wholePart = whole.replace(/(\d)(?=(?:\d{3})+(?:\D|$))/gu, `$1${DELIMITER}`);
  const number = [wholePart, decimalPart].filter((part) => part !== null).join(SEPARATOR);
  const sign = negative ? "-" : "";

  let formatted: string;
  if (symbol) {
    const template = currency.format ?? (currency.symbol_first ? "%u%n" : "%n %u");
    formatted = template.replaceAll("%u", symbol).replaceAll("%n", `${sign}${number}`);
  } else {
    formatted = `${sign}${number}`;
  }
  // Currency#to_s is the id the currency was found by (an alias such as "yen" stays "YEN"), not the ISO code.
  return options.withCurrency ? `${formatted} ${code.toUpperCase()}` : formatted;
}

// MoneyFormatter.format(amount, currency_type, opts), which soft-fails an unknown code to its ISO code.
export function moneyFormatterFormat(amount: MoneyAmount, currencyType: string, options: MoneyFormatOptions & { symbol?: boolean } = {}): string {
  const withSymbol = options.symbol !== false;
  const code = currencyType.toLowerCase();
  const known = code !== "" && Object.hasOwn(CURRENCIES, code);
  if (!known) {
    const number = formatMoney(amount, CURRENCIES.usd!, "usd", null, options);
    const iso = code.toUpperCase();
    return withSymbol && iso !== "" ? `${number} ${iso}` : number;
  }
  const currency = CURRENCIES[code]!;
  return formatMoney(amount, currency, code, withSymbol ? (Object.hasOwn(CHOICES_SYMBOLS, code) ? CHOICES_SYMBOLS[code]! : currency.symbol) : null, options);
}

// MoneyFormatter.symbol_for
export function symbolFor(currencyType: string): string {
  const code = currencyType.toLowerCase();
  if (code === "" || !Object.hasOwn(CURRENCIES, code)) return code.toUpperCase();
  return Object.hasOwn(CHOICES_SYMBOLS, code) ? CHOICES_SYMBOLS[code]! : (CURRENCIES[code]!.symbol ?? "");
}

// CurrencyHelper#formatted_price
export const formattedPrice = (currencyType: string, price: MoneyAmount): string => moneyFormatterFormat(price, currencyType, { noCentsIfWhole: true });

// CurrencyHelper#format_just_price_in_cents
export function formatJustPriceInCents(amountCents: MoneyAmount, currencyType: string): string {
  const price = formattedPrice(currencyType, amountCents);
  return price === "$0.99" ? "99¢" : price;
}

// CurrencyHelper#formatted_amount_in_currency (raises for a code the gem does not know)
export function formattedAmountInCurrency(amountCents: MoneyAmount, currencyType: string, noCentsIfWhole = true): string {
  return formatMoney(amountCents, findCurrency(currencyType), currencyType.toLowerCase(), null, { noCentsIfWhole, withCurrency: true });
}

// StripeChargeProcessor.charge_subunit_to_unit
const chargeSubunitToUnit = (currency: string): number => (ZERO_DECIMAL_CHARGE_CURRENCIES.has(currency.toLowerCase()) ? 1 : subunitToUnit(currency));

// StripeChargeProcessor.money_subunits_from_charge_amount: Stripe's charge units to Gumroad's storage scale.
export function moneySubunitsFromChargeAmount(amountCents: number | bigint | null, currency: string): number {
  const amount = amountCents === null ? 0 : Number(amountCents);
  const chargeSub = chargeSubunitToUnit(currency);
  if (chargeSub <= 0) return amount;
  const gumroadSub = subunitToUnit(currency);
  if (gumroadSub === chargeSub) return amount;
  return new D(amount).mul(gumroadSub).div(chargeSub).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

// StripeChargeProcessor.format_charge_presentment_amount
export function formatChargePresentmentAmount(amountCents: number | bigint | null, currency: string): string {
  return moneyFormatterFormat(moneySubunitsFromChargeAmount(amountCents, currency), currency, { noCentsIfWhole: true });
}
