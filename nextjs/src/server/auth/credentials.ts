// Password login as LoginsController#create decides it, in the same order, so the same input gets
// the same refusal. Signing in (trackable columns, remember cookie, guest cart merge) is WS-10's.
import type { User } from "@prisma/client";

import { deviseConfig, validPassword, type DeviseConfig } from "./devise-password";
import type { AuthStore } from "./store";
import { UserFlags } from "../models/user";

// Rails shows these verbatim, so the codes and messages stay distinct as they are there.
export const LOGIN_ERRORS = {
  account_not_found: "An account does not exist with that email.",
  invalid_password: "Please try another password. The one you entered was incorrect.",
  deleted_account:
    "You cannot log in because your account was deleted. Email support@gumroad.com if you'd like to use this email address for a new account.",
  // Not a Rails message: Rails starts the 2FA challenge, which is not ported yet.
  two_factor_required: "Two-factor authentication is required. Please log in on the main site.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERRORS;

export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode) {
    super(LOGIN_ERRORS[code]);
    this.name = "LoginError";
  }
}

export async function authorizePassword(
  input: { login_identifier?: unknown; password?: unknown },
  store: Pick<AuthStore, "findUserForLogin">,
  config: DeviseConfig = deviseConfig(),
): Promise<User> {
  const identifier = typeof input.login_identifier === "string" ? input.login_identifier : "";
  const password = typeof input.password === "string" ? input.password : null;

  const user = identifier.trim() === "" ? null : await store.findUserForLogin(identifier);
  if (!user) throw new LoginError("account_not_found");
  if (!(await validPassword(user.encrypted_password, password, config))) throw new LoginError("invalid_password");
  if (user.deleted_at) throw new LoginError("deleted_account");
  // Rails would skip the challenge for a remembered browser or a known IP. Without that port,
  // signing in here would bypass 2FA, so every 2FA user is sent to Rails.
  if (UserFlags.isSet(user.flags, "two_factor_authentication_enabled")) throw new LoginError("two_factor_required");
  return user;
}
