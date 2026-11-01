// app/policies/settings/team/team_invitation_policy.rb
import { isAccountActive, Users } from "../../models/user.ts";
import { requireUser, roleAdminFor, roleOwnerFor, type SellerContext } from "../seller-context.ts";

const update = (context: SellerContext) => roleAdminFor(requireUser(context));
// `seller&.account_active? && update?`
const create = (context: SellerContext) => {
  const c = requireUser(context);
  return c.seller !== null && isAccountActive(Users.load(c.seller)) && update(c);
};

export const settingsTeamInvitationPolicy = {
  create,
  update,
  destroy: update,
  restore: update,
  accept: (context: SellerContext) => roleOwnerFor(requireUser(context)),
  resendInvitation: create,
};
