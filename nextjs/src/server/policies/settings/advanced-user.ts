// app/policies/settings/advanced/user_policy.rb
import { requireUser, roleAdminFor, type SellerContext } from "../seller-context.ts";

const show = (context: SellerContext) => roleAdminFor(requireUser(context));

export const settingsAdvancedUserPolicy = {
  show,
  update: show,
  testPing: show,
  rotatePingSigningSecret: show,
  disablePingSigning: show,
};
