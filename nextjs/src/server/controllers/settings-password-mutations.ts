// Settings::PasswordController#update (app/controllers/settings/password_controller.rb).
//
// Ported: the owner-only authorization, the "confirm your email" refusal of an OAuth account, the "Incorrect password." refusal of a
// missing or wrong current password, and the change itself: digest and save the new password (an OAuth account's first one drops its
// provider), sign the other sessions out, and keep this browser signed in with the new salt (Devise's bypass_sign_in).
// Handed to Rails whole, before any write: a `user` param that is neither a hash nor blank (Rails reads it through String#[]), a
// current or new password that is not text, and a change made while impersonating.
import { authenticatableSalt, validPassword } from "../auth/devise-password.ts";
import { WARDEN_SCOPE_SESSION_KEY, WARDEN_USER_KEY } from "../auth/warden.ts";
import { findUserBang, isConfirmed, setPassword, Users, type UserRecord } from "../models/user.ts";
import { invalidateActiveSessions } from "../models/user-risk.ts";
import { domainConfig } from "../page-props/domain.ts";
import { settingsGuard } from "../page-props/settings/guard.ts";
import { settingsPasswordUserPolicy } from "../policies/settings/password-user.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const FOUND = 302;
const SEE_OTHER = 303;
const FLASH_PASSWORD_CHANGED = "You have successfully changed your password.";
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

// Array#to_sentence
const toSentence = (items: string[]): string =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

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
  const params = input.params.user;
  if (!blank(user.get("provider"))) {
    if (!isConfirmed(user)) return alert(FLASH_CONFIRM_EMAIL);
    if (!isHash(params)) throw new HandBackToRails("an OAuth account setting a password without a user hash");
    user.set("provider", null);
    return changePassword(input, user, params.new_password);
  }

  if (!blank(params) && !isHash(params)) throw new HandBackToRails("a user param that is not a hash");
  const password = isHash(params) ? params.password : undefined;
  if (blank(password)) return alert(FLASH_INCORRECT_PASSWORD);
  if (typeof password !== "string") throw new HandBackToRails("a current password that is not text");
  if (!(await validPassword(user.get("encrypted_password"), password))) return alert(FLASH_INCORRECT_PASSWORD);
  return changePassword(input, user, (params as Record<string, unknown>).new_password);
}

// `@user.password = ...; @user.save`, then the other sessions go and the current one keeps signing in with the new password's salt.
async function changePassword(input: MutationInput, user: UserRecord, newPassword: unknown): Promise<ActionResult> {
  const { chain, context } = input;
  if (newPassword !== undefined && newPassword !== null && typeof newPassword !== "string")
    throw new HandBackToRails("a new password that is not text");
  // `logged_in_user` is a separate instance, loaded before the save.
  const visitor = context.loggedInUser;
  if (visitor === null || context.impersonatedUser !== null) throw new HandBackToRails("a password change by someone other than the owner");
  const signedIn = await findUserBang(visitor.id);

  await setPassword(user, newPassword ?? null);
  if (!(await Users.save(user, { now: () => chain.now }))) {
    return alert(`New password ${toSentence(user.errors.on("password"))}`);
  }

  await invalidateActiveSessions(signedIn, () => chain.now);
  // The session keeps the current browser signed in: `warden.session["last_sign_in_at"]`, then Devise's bypass_sign_in.
  chain.session.data[WARDEN_SCOPE_SESSION_KEY] = {
    ...(chain.session.data[WARDEN_SCOPE_SESSION_KEY] as Record<string, unknown> | undefined),
    last_sign_in_at: Math.floor(chain.now.getTime() / 1000),
  };
  chain.session.data[WARDEN_USER_KEY] = [[Number(user.get("id"))], authenticatableSalt(user.get("encrypted_password"))];
  return { status: SEE_OTHER, location: PASSWORD_PATH, flash: { notice: FLASH_PASSWORD_CHANGED } };
}

registerMutations(
  { method: "PUT", pattern: PASSWORD_PATH, run: update },
  { method: "PATCH", pattern: PASSWORD_PATH, run: update },
);
