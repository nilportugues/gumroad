// app/policies/settings/password/user_policy.rb: only the account owner, never a team member.
import { requireUser, roleOwnerFor, type SellerContext } from "../seller-context.ts";

function show(context: SellerContext): boolean {
  return roleOwnerFor(requireUser(context));
}

export const settingsPasswordUserPolicy = { show, update: show };
