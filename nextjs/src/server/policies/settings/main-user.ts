// app/policies/settings/main/user_policy.rb
import { requireUser, roleAdminFor, roleOwnerFor, type SellerContext } from "../seller-context.ts";

const show = (context: SellerContext) => roleAdminFor(requireUser(context));
const update = (context: SellerContext) => roleOwnerFor(requireUser(context));

export const settingsMainUserPolicy = {
  show,
  update,
  resendConfirmationEmail: update,
  invalidateActiveSessions: update,
  updateUsername: update,
};
