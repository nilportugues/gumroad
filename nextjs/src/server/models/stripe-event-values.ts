// Reading Stripe event payloads the way `Stripe::Util.convert_to_stripe_object` and ActiveRecord's column casts do, for the
// event handlers that serve a Sidekiq-delivered event in Node.
import { NotPortedError } from "./user.ts";

export type EventObject = Record<string, unknown>;

export const isObject = (value: unknown): value is EventObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const INT64_MAX = 2n ** 63n - 1n;

// ActiveModel::Type::Integer for a String: `to_i` when it starts with a digit (after whitespace and a sign), else nil, which the
// statement binds as `= NULL`. A value past the column's range makes ActiveRecord skip the query, which is not ported.
export function railsIntegerCast(value: string): bigint | null {
  const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(value);
  if (!match) return null;
  const cast = BigInt(match[1]!.replaceAll("_", ""));
  if (cast > INT64_MAX || cast < -INT64_MAX - 1n)
    throw new NotPortedError("an id outside the bigint range", "ActiveModel::RangeError");
  return cast;
}
