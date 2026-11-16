// Float#round(digits) as MRI computes it (float.c round_half_up): the half-up correction runs on the scaled
// value, so ties can land differently from Math.round(x * 100) / 100.
const CENTS_DIGITS = 2;

// C round(): half away from zero.
function cRound(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function rubyRoundHalfUp(x: number, digits: number = CENTS_DIGITS): number {
  if (x === 0) return x;
  const scale = 10 ** digits;
  let f = cRound(x * scale);
  if (x > 0) {
    if ((f + 0.5) / scale <= x) f += 1;
  } else if ((f - 0.5) / scale >= x) {
    f -= 1;
  }
  return f / scale;
}
