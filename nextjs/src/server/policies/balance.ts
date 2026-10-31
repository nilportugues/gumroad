// app/policies/balance_policy.rb
import { requireUser, roleAccountantFor, roleAdminFor, roleSupportFor, type SellerContext } from "./seller-context";

export const balancePolicy = {
  index(context: SellerContext): boolean {
    const c = requireUser(context);
    return roleAccountantFor(c) || roleAdminFor(c) || roleSupportFor(c);
  },
  export: (context: SellerContext): boolean => balancePolicy.index(context),
};
