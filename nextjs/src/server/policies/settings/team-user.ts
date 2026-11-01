// app/policies/settings/team/user_policy.rb
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "../seller-context.ts";

export const settingsTeamUserPolicy = {
  show: (context: SellerContext) => {
    const c = requireUser(context);
    return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
  },
};
