// Ruby's Integer/Float conversions the price arithmetic leans on. Golden: the vectors in
// worker/jobs/__fixtures__/offer-code-pricing-vectors.golden.json (scripts/golden/offer-code-pricing-vectors.rb).

// FloatDomainError, as `Float#round` raises it for a non-finite value.
export class FloatDomainError extends Error {
  constructor(value: number) {
    super(Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity");
    this.name = "FloatDomainError";
  }
}

// `Float#round` with no digits: half away from zero (C `round`), to an Integer. `x - trunc(x)` is
// exact in binary floating point, so the half test is too.
export function rubyRound(value: number): number {
  if (!Number.isFinite(value)) throw new FloatDomainError(value);
  const whole = Math.trunc(value);
  const result = Math.abs(value - whole) >= 0.5 ? whole + Math.sign(value) : whole;
  return result === 0 ? 0 : result;
}

// `Integer#/` and `Integer#%` floor toward negative infinity.
export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
export const floorMod = (a: number, b: number): number => ((a % b) + b) % b;

// `String#to_i`, `Integer#to_i`, `Float#to_i`, `nil.to_i`. Other receivers have no `to_i`.
export function rubyToI(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const match = /^[ \t\n\v\f\r]*([+-]?\d+(?:_\d+)*)/u.exec(value);
    return match ? Number(match[1]!.replaceAll("_", "")) : 0;
  }
  throw new TypeError(`undefined method 'to_i' for ${typeof value === "boolean" ? String(value) : "an instance of " + (Array.isArray(value) ? "Array" : "Hash")}`);
}

// C's frexp exponent: x = m * 2**binexp with 0.5 <= |m| < 1 (0 for zero and non-finite values).
function frexpExponent(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return 0;
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  const biased = (bits.getUint16(0) >> 4) & 0x7ff;
  if (biased === 0) return frexpExponent(value * 2 ** 54) - 54;
  return biased - 1022;
}

// C's `round`: half away from zero.
function cRound(value: number): number {
  const whole = Math.trunc(value);
  return Math.abs(value - whole) >= 0.5 ? whole + Math.sign(value) : whole;
}

// `Float#round(ndigits)` for 0 < ndigits <= 14: numeric.c's rb_flo_round_by_double with ROUND_HALF_UP.
export function rubyFloatRoundDigits(number: number, ndigits: number): number {
  if (number === 0) return number;
  const binexp = frexpExponent(number);
  // float_round_overflow: the digits asked for are beyond the Float's precision, so it is returned as is
  if (ndigits >= 17 - (binexp > 0 ? Math.trunc(binexp / 4) : Math.trunc(binexp / 3) - 1)) return number;
  // float_round_underflow
  if (ndigits < -(binexp > 0 ? Math.trunc(binexp / 3) + 1 : Math.trunc(binexp / 4))) return 0;
  const scale = 10 ** ndigits;
  let rounded = cRound(number * scale);
  if (number > 0) {
    if ((rounded + 0.5) / scale <= number) rounded += 1;
  } else if ((rounded - 0.5) / scale >= number) {
    rounded -= 1;
  }
  return rounded / scale;
}
