/** Narrows a possibly missing value or throws a message naming it; replaces non-null assertions. */
export const present = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present`);
  return value;
};
