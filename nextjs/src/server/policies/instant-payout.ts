// app/policies/instant_payout_policy.rb
import { requireUser, roleAccountantFor, roleAdminFor, type SellerContext } from "./seller-context.ts";

export const instantPayoutPolicy = {
  create: (context: SellerContext): boolean => {
    const c = requireUser(context);
    return roleAccountantFor(c) || roleAdminFor(c);
  },
};
