// app/policies/user_policy.rb: the queries the settings pages read.
import { UserFlags } from "../models/user.ts";
import { requireUser, roleAdminFor, roleMarketingFor, roleOwnerFor, type SellerContext } from "./seller-context.ts";

export const userPolicy = {
  // `seller.eligible_for_ai_product_generation? && (...)`: eligibility reads the database, so the caller passes it in. Ruby's `&&`
  // skips the role lookups (which can raise) for an ineligible seller.
  generateProductDetailsWithAi: (context: SellerContext, eligible: boolean) => {
    if (!eligible) return false;
    const c = requireUser(context);
    return UserFlags.isSet(c.user.flags, "is_team_member") || c.user.id === c.seller?.id || roleAdminFor(c) || roleMarketingFor(c);
  },
  deactivate: (context: SellerContext) => roleOwnerFor(requireUser(context)),
};
