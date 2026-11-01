// app/policies/user_policy.rb: the queries the settings and agent pages read.
import { requireUser, roleAdminFor, roleMarketingFor, roleOwnerFor, type SellerContext } from "./seller-context.ts";

export const userPolicy = {
  deactivate: (context: SellerContext) => roleOwnerFor(requireUser(context)),
  // The role may open the Agent tab; the earned-access bar is a separate check (use_store_agent?).
  viewStoreAgent: (context: SellerContext) => {
    const c = requireUser(context);
    return c.user.id === c.seller?.id || roleAdminFor(c) || roleMarketingFor(c);
  },
};
