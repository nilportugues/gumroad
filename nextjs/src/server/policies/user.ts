// app/policies/user_policy.rb: the queries the settings pages read.
import { requireUser, roleOwnerFor, type SellerContext } from "./seller-context.ts";

export const userPolicy = { deactivate: (context: SellerContext) => roleOwnerFor(requireUser(context)) };
