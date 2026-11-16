// Ruby raises ArgumentError when `perform` gets the wrong number of arguments, which fails the
// job into the retry set; handlers check the same bounds so a malformed payload fails the same way.
export function checkArity(args: readonly unknown[], min: number, max: number = min): void {
  if (args.length >= min && args.length <= max) return;
  const expected = min === max ? String(min) : max === Infinity ? `${min}+` : `${min}..${max}`;
  throw new Error(`wrong number of arguments (given ${args.length}, expected ${expected})`);
}
