export function isTuple<T, N extends number>(array: T[], length: N): array is Tuple<T, N> {
  return array.length === length;
}

export function isOpenTuple<T, N extends number>(array: T[], length: N): array is [...Tuple<T, N>, ...T[]] {
  return array.length >= length;
}

// The second overload covers callers type-checked without the Rails app's `String#split` retyping
// (the Next.js build), where an array may be empty.
export function last<T>(array: readonly [T, ...T[]]): T;
export function last<T>(array: readonly T[]): T | undefined;
export function last<T>(array: readonly T[]): T | undefined {
  return array[array.length - 1];
}
