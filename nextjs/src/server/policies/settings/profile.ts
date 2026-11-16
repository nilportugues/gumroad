// app/policies/settings/profile_policy.rb, without #permitted_attributes (form submissions stay in Rails).
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleOwnerFor, roleSupportFor, type SellerContext } from "../seller-context.ts";

const updateUsername = (context: SellerContext) => roleOwnerFor(requireUser(context));

export const settingsProfilePolicy = {
  show: (context: SellerContext) => {
    const c = requireUser(context);
    return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
  },
  update: (context: SellerContext) => {
    const c = requireUser(context);
    return roleAdminFor(c) || roleMarketingFor(c);
  },
  updateUsername,
  manageSocialConnections: updateUsername,
};
