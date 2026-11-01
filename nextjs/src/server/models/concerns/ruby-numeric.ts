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
