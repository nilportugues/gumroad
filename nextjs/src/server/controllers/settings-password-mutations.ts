// Settings::PasswordController#update (app/controllers/settings/password_controller.rb).
//
// Ported: the owner-only authorization, the "confirm your email" refusal of an OAuth account, and the "Incorrect password." refusal of
// a missing or wrong current password.
// Handed to Rails whole, before any write: a password change that passes those checks (it digests the new password, saves, and signs
// the other sessions out), and a `user` param that is neither a hash nor blank, which Rails reads through String#[].
import { validPassword } from "../auth/devise-password.ts";
import { findUserBang, isConfirmed } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { settingsGuard } from "../page-props/settings/guard.ts";
import { settingsPasswordUserPolicy } from "../policies/settings/password-user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const FOUND = 302;
const PASSWORD_PATH = "/settings/password";
const FLASH_CONFIRM_EMAIL = "You have to confirm your email address before you can do that.";
const FLASH_INCORRECT_PASSWORD = "Incorrect password.";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Object#blank? for what a request can carry: nil, false, a whitespace string and an empty collection.
function blank(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return isHash(value) && Object.keys(value).length === 0;
}

const alert = (message: string): ActionResult => ({
  status: FOUND,
  location: PASSWORD_PATH,
  flash: { alert: message },
});

// PUT|PATCH /settings/password
async function update(input: MutationInput): Promise<ActionResult> {
  const denied = await settingsGuard({ authorize: settingsPasswordUserPolicy.update })({
    context: input.context,
    config: domainConfig(process.env),
    url: input.url,
    params: input.routeParams,
    urlOptions: input.urlOptions,
  });
  if (denied) return denied;

  const user = await findUserBang(input.context.currentSeller!.id);
  if (!blank(user.get("provider"))) {
    if (!isConfirmed(user)) return alert(FLASH_CONFIRM_EMAIL);
    throw new HandBackToRails("an OAuth account setting its first password, which is digested and saved");
  }

  const params = input.params.user;
  if (!blank(params) && !isHash(params)) throw new HandBackToRails("a user param that is not a hash");
  const password = isHash(params) ? params.password : undefined;
  if (blank(password)) return alert(FLASH_INCORRECT_PASSWORD);
  if (typeof password !== "string") throw new HandBackToRails("a current password that is not text");
  if (!(await validPassword(user.get("encrypted_password"), password))) return alert(FLASH_INCORRECT_PASSWORD);
  throw new HandBackToRails("a password change, which is digested and saved and signs the other sessions out");
}

registerMutations(
  { method: "PUT", pattern: PASSWORD_PATH, run: update },
  { method: "PATCH", pattern: PASSWORD_PATH, run: update },
);
