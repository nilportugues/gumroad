// Pundit's `authorize(record, :query?)`: raise unless the policy allows it.
import { NotAuthorizedError, type SellerContext } from "./seller-context";

export type PolicyQuery<R = undefined> = (context: SellerContext, record: R) => boolean;

export function authorize<R>(query: PolicyQuery<R>, context: SellerContext, record: R): void;
export function authorize(query: PolicyQuery, context: SellerContext): void;
export function authorize<R>(query: PolicyQuery<R>, context: SellerContext, record?: R): void {
  if (!query(context, record as R)) throw new NotAuthorizedError(`not allowed to ${query.name || "perform this action"}`);
}
