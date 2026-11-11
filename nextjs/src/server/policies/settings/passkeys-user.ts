// app/policies/settings/passkeys/user_policy.rb: only the account owner; every action shares registration_options?.
import { requireUser, roleOwnerFor, type SellerContext } from "../seller-context.ts";

function registrationOptions(context: SellerContext): boolean {
  return roleOwnerFor(requireUser(context));
}

export const settingsPasskeysUserPolicy = {
  registrationOptions,
  create: registrationOptions,
  update: registrationOptions,
  destroy: registrationOptions,
};
