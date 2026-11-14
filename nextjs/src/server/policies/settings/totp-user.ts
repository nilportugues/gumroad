// app/policies/settings/totp/user_policy.rb: only the account owner; every action shares create?.
import { requireUser, roleOwnerFor, type SellerContext } from "../seller-context.ts";

function create(context: SellerContext): boolean {
  return roleOwnerFor(requireUser(context));
}

export const settingsTotpUserPolicy = { create, confirm: create, destroy: create, regenerateRecoveryCodes: create };
