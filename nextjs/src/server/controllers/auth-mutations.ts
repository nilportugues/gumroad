// The POST/DELETE side of the authentication pages: LoginsController#create and #destroy, TwoFactorAuthenticationController's
// actions. Devise's sign-in and sign-out live in auth-session.ts; the rest of the Devise session bookkeeping is the session and
// cookie jar the request chain already carries.
//
// Whatever the port cannot prove goes to Rails before the first write: a signed-in visitor posting the login form, an unconfirmed
// account (Devise's activatable hook refuses it), a guest cart to merge, a recovery code (it burns the code) and parameters that are
// not plain strings.
import { compare } from "bcryptjs";

import { db } from "../../lib/db.ts";
import { decrypt as obfuscateDecrypt } from "../../lib/obfuscate-ids.ts";
import { verifyTotp } from "../../lib/rotp.ts";
import { validPassword } from "../auth/devise-password.ts";
import { prismaAuthStore } from "../auth/store.ts";
import { isBlank } from "../html/text-helper.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { currentJobsRuntime } from "../models/concerns/job-runtime.ts";
import { sendAuthenticationToken } from "../models/two-factor-authentication.ts";
import { findUser, isConfirmed, isFlagSet, passwordIsPwned, type UserRecord } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";

import {
  type ActionOptions,
  type ActionResult,
  allowedReferrer,
  type Chain,
  HandBackToRails,
  type Redirected,
  RoutingError,
} from "./application-controller.ts";
import {
  referrerIsValidAfterLoginPath,
  sessionPresent,
  setWarning,
  signedInUserHome,
  TWO_FACTOR_EXPIRED_FLASH,
  TWO_FACTOR_METHOD_SESSION_KEY,
  TWO_FACTOR_SENT_AT_SESSION_KEY,
  TWO_FACTOR_USER_SESSION_KEY,
} from "./auth-pages.ts";
import {
  addTwoFactorAuthenticatedIp,
  mergeGuestCartWithUserCart,
  planGuestCart,
  clearDashboardPreference,
  refreshPasskeySetupPrompt,
  rememberedTwoFactor,
  signIn,
  signOutUser,
  twoFactorAuthCookie,
} from "./auth-session.ts";
import { type MutationInput, registerMutations, remoteIp } from "./mutation.ts";
import { cgiEscape, cgiUnescape, referrer, safeRedirectPath } from "./rails-params.ts";
import { fullpath } from "./rails-request.ts";

const LOGIN_PATH = "/login";
const TWO_FACTOR_PATH = "/two-factor";
const VERIFY_TWO_FACTOR_PATH = "/two-factor/verify.html";
const DELETED_ACCOUNT_LOGIN_ERROR =
  "You cannot log in because your account was deleted. Email support@gumroad.com if you'd like to use this email address for a new account.";
const PWNED_PASSWORD_WARNING =
  "Your password has previously appeared in a data breach as per haveibeenpwned.com and should never be used. We strongly recommend you change your password everywhere you have used it.";
const SIGNED_OUT_FLASH = "Signed out successfully.";
const DEFAULT_AUTH_TOKEN = "000000";
// TwoFactorAuthentication::TOKEN_VALIDITY and TotpCredential::DRIFT, in seconds.
const TOKEN_VALIDITY_SECONDS = 10 * 60;
const TOTP_DRIFT_SECONDS = 30;

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A param Rails would read as a String (or nil); anything else is a shape the port leaves to Rails.
function stringParam(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new HandBackToRails("a parameter that is not a string");
}

const nowSeconds = (chain: Chain) => Math.floor(chain.now.getTime() / 1000);

const config = () => domainConfig(process.env);

function clientIp(input: MutationInput): string {
  const ip = remoteIp(input.request);
  if (ip === null) throw new HandBackToRails("a request with no client address");
  return ip;
}

// The Devise `prepend_before_action :require_no_authentication` of LoginsController#create: a signed-in visitor is sent where a login
// would have sent them, which depends on `params[:next]` and the referrer; the port leaves it to Rails.
export async function requireSignedOut(chain: Chain): Promise<Redirected | null> {
  if (chain.auth.context.loggedInUser || chain.auth.effects.signedOut)
    throw new HandBackToRails("a signed-in visitor posting the login form");
  return null;
}

// ApplicationController#login_path_for
export async function loginPathFor(chain: Chain, userId: bigint, params: Record<string, unknown>): Promise<string> {
  const next = stringParam(params.next);
  let final: string;
  if (next !== null && !isBlank(next)) final = cgiUnescape(next);
  else if (referrerIsValidAfterLoginPath(chain)) final = referrer(chain.request)!;
  else final = await signedInUserHome(userId);

  const safe = safeRedirectPath(final, chain.request, { rootDomain: config().rootDomain });
  if (safe.startsWith(VERIFY_TWO_FACTOR_PATH)) return safe;

  // A stale two-factor login of another user is dropped.
  const pending = chain.session.data[TWO_FACTOR_USER_SESSION_KEY];
  if (sessionPresent(pending) && Number(pending) !== Number(userId)) resetTwoFactorSession(chain);
  const stillPending = chain.session.data[TWO_FACTOR_USER_SESSION_KEY];
  if (sessionPresent(stillPending)) {
    // user_for_two_factor_authentication: User.find
    const user = await findUser(stillPending);
    if (user === null) throw new RoutingError("Not Found");
    return `${TWO_FACTOR_PATH}?next=${cgiEscape(safe)}`;
  }
  return safe;
}

export function resetTwoFactorSession(chain: Chain): void {
  delete chain.session.data[TWO_FACTOR_USER_SESSION_KEY];
  delete chain.session.data[TWO_FACTOR_METHOD_SESSION_KEY];
  delete chain.session.data[TWO_FACTOR_SENT_AT_SESSION_KEY];
}

const loginError = (message: string): Redirected => ({
  status: 303,
  location: LOGIN_PATH,
  flash: { warning: message },
});

// User::DeviseInternal#active_for_authentication? is always true, so an unconfirmed address signs in. Only the emailed two-factor
// code confirms it (`user.confirm if two_factor_auth_method == "email" && !user.confirmed? && !user.pending_reconfirmation?`).
function assertNothingToConfirm(chain: Chain, user: UserRecord): void {
  if (twoFactorMethod(chain) === "email" && !isConfirmed(user))
    throw new HandBackToRails("an emailed two-factor code that confirms the address");
}

async function totpEnabled(userId: bigint): Promise<boolean> {
  const credential = await db.totpCredential.findUnique({ where: { user_id: userId } });
  return credential?.confirmed_at != null;
}

// TwoFactorAuthenticationValidator#prepare_for_two_factor_authentication
export async function prepareTwoFactorAuthentication(
  chain: Chain,
  user: UserRecord,
  params: Record<string, unknown>,
): Promise<void> {
  chain.session.data[TWO_FACTOR_USER_SESSION_KEY] = Number(user.get("id"));
  if (await totpEnabled(user.get("id"))) {
    chain.session.data[TWO_FACTOR_METHOD_SESSION_KEY] = "totp";
    return;
  }
  chain.session.data[TWO_FACTOR_METHOD_SESSION_KEY] = "email";
  // The token already travels in the next URL (the emailed login link).
  const next = params.next;
  if (next !== undefined && next !== null && typeof next !== "string")
    throw new HandBackToRails("a next parameter that is not a string");
  if (typeof next === "string" && next !== "" && next.includes(VERIFY_TWO_FACTOR_PATH)) return;
  await sendAuthenticationToken(currentJobsRuntime(), { id: user.get("id"), email: user.get("email") });
  chain.session.data[TWO_FACTOR_SENT_AT_SESSION_KEY] = nowSeconds(chain);
}

async function loginCreate(input: MutationInput): Promise<ActionResult> {
  const { chain, params } = input;
  let found = null;
  let password: string | null = null;
  if (isHash(params.user)) {
    const identifier = stringParam(params.user.login_identifier);
    password = stringParam(params.user.password);
    if (identifier !== null && !isBlank(identifier)) found = await prismaAuthStore.findUserForLogin(identifier);
  }
  if (found === null) return loginError("An account does not exist with that email.");
  if (!(await validPassword(found.encrypted_password, password)))
    return loginError("Please try another password. The one you entered was incorrect.");
  if (found.deleted_at !== null) return loginError(DELETED_ACCOUNT_LOGIN_ERROR);

  const user = await findUser(found.id);
  if (user === null) throw new HandBackToRails("a user that vanished");
  const ip = clientIp(input);

  const cookies: string[] = [];
  let signedIn = false;
  const remembered = isFlagSet(user, "two_factor_authentication_enabled")
    ? await rememberedTwoFactor(chain, user, ip)
    : { skip: true, cookies: [] };
  if (remembered.skip) {
    const cartMerge = await planGuestCart(chain, user);
    cookies.push(...remembered.cookies);
    cookies.push(...(await signIn(chain, user, { remember: true, remoteIp: ip })));
    signedIn = true;
    resetTwoFactorSession(chain);
    await mergeGuestCartWithUserCart(chain, cartMerge);
    await refreshPasskeySetupPrompt(chain, user);
  } else {
    await prepareTwoFactorAuthentication(chain, user, params);
  }

  // devise-pwned_password's after_set_user hook: the password sent with the form is checked once the user is signed in.
  const flash: Record<string, string> = {};
  if (
    signedIn &&
    isHash(params.user) &&
    params.user.password != null &&
    password !== null &&
    (await passwordIsPwned(password))
  )
    flash.warning = PWNED_PASSWORD_WARNING;

  return {
    status: 302,
    location: await loginPathFor(chain, user.get("id"), params),
    cookies,
    ...(Object.keys(flash).length > 0 ? { flash } : {}),
  };
}

// after_sign_out_path_for: `url_from(request.referrer) || "/"`
const afterSignOutPath = (chain: Chain) => allowedReferrer(chain.request) ?? "/";

// Devise's `verify_signed_out_user`: a prepended filter that answers a visitor with no session without running the rest of the chain.
async function verifySignedOutUser(chain: Chain): Promise<Redirected | null> {
  if (chain.auth.effects.signedOut) throw new HandBackToRails("a session that was invalidated");
  if (chain.auth.context.loggedInUser) return null;
  chain.session.data.flash = { discard: [], flashes: { notice: SIGNED_OUT_FLASH } };
  return { status: 302, location: afterSignOutPath(chain) };
}

async function logout({ chain, context }: MutationInput): Promise<ActionResult> {
  const user = context.loggedInUser;
  if (user === null) throw new HandBackToRails("a logout with no session");
  // reset_impersonated_user, then sign_out and the after_action clear_dashboard_preference
  await prismaAuthStore.clearImpersonation(user.id);
  const cookies = await signOutUser(chain, user);
  cookies.push(...clearDashboardPreference(chain));
  return { status: 302, location: afterSignOutPath(chain), flash: { notice: SIGNED_OUT_FLASH }, cookies };
}

const LOGIN_OPTIONS: ActionOptions = { skip: ["check_suspended"], prepended: requireSignedOut };
const LOGOUT_OPTIONS: ActionOptions = { skip: ["check_suspended"], prepended: verifySignedOutUser };
const TWO_FACTOR_OPTIONS: ActionOptions = { skip: ["check_suspended"] };

// ---- two-factor authentication -------------------------------------------------------------------------------------------

const twoFactorMethod = (chain: Chain): string => {
  const method = chain.session.data[TWO_FACTOR_METHOD_SESSION_KEY];
  return sessionPresent(method) ? String(method) : "email";
};

type TwoFactorStep = { user: UserRecord } | { halt: ActionResult };

// The before_actions of TwoFactorAuthenticationController: redirect_to_signed_in_path, fetch_user, redirect_to_login_path,
// validate_user_id_from_params.
async function twoFactorUser({ chain, params, request }: MutationInput): Promise<TwoFactorStep> {
  if (chain.auth.context.loggedInUser || chain.auth.effects.signedOut)
    throw new HandBackToRails("a signed-in visitor on the two-factor routes");

  const userId = chain.session.data[TWO_FACTOR_USER_SESSION_KEY];
  const user = sessionPresent(userId) ? await findUser(userId) : null;
  if (sessionPresent(userId) && user === null) throw new RoutingError("Not Found");
  if (user === null) {
    setWarning(chain, TWO_FACTOR_EXPIRED_FLASH);
    const next = request.method === "GET" ? `?next=${cgiEscape(fullpath(request))}` : "";
    return { halt: { status: 303, location: `${LOGIN_PATH}${next}`, rescued: true } };
  }

  const externalId = stringParam(params.user_id);
  let decrypted: number | null = null;
  try {
    decrypted = externalId === null ? null : obfuscateDecrypt(externalId);
  } catch {
    decrypted = null;
  }
  if (decrypted === null || String(decrypted) !== user.get("external_id")) throw new RoutingError("Not Found");
  return { user };
}

// TotpCredential#redeem_recovery_code burns the code it matches; the port only recognises that case.
async function recoveryCodeMatches(userId: bigint, token: string): Promise<boolean> {
  const credential = await db.totpCredential.findUnique({ where: { user_id: userId } });
  if (!credential?.recovery_codes) return false;
  const codes = JSON.parse(credential.recovery_codes) as string[];
  const normalized = token.toUpperCase().replaceAll("-", "").trim();
  for (const hash of codes) if (await compare(normalized, hash)) return true;
  return false;
}

async function validTwoFactorToken(chain: Chain, user: UserRecord, token: string | null): Promise<boolean> {
  const method = twoFactorMethod(chain);
  const defaultToken = railsEnv() !== "production" && token === DEFAULT_AUTH_TOKEN;
  if (method === "totp" || method === "recovery") {
    const credential = await db.totpCredential.findUnique({ where: { user_id: user.get("id") } });
    if (method === "totp") {
      if (
        credential &&
        token !== null &&
        token !== "" &&
        verifyTotp(credential.otp_secret, token, TOTP_DRIFT_SECONDS, chain.now)
      )
        return true;
      return defaultToken;
    }
    if (token !== null && (await recoveryCodeMatches(user.get("id"), token)))
      throw new HandBackToRails("a recovery code");
    return defaultToken;
  }
  // token_authenticated?
  const secret = user.get("otp_secret_key");
  if (secret && token !== null && token !== "" && verifyTotp(secret, token, TOKEN_VALIDITY_SECONDS, chain.now))
    return true;
  return defaultToken;
}

async function verifyAuthTokenAndRedirect(input: MutationInput, user: UserRecord): Promise<ActionResult> {
  const { chain, params } = input;
  const token = stringParam(params.token);
  if (!(await validTwoFactorToken(chain, user, token))) {
    return { status: 303, location: TWO_FACTOR_PATH, flash: { warning: "Invalid token, please try again." } };
  }

  // sign_in_with_two_factor_authentication
  assertNothingToConfirm(chain, user);
  const cartMerge = await planGuestCart(chain, user);
  const ip = clientIp(input);
  const cookies = await signIn(chain, user, { remember: false, remoteIp: ip });
  cookies.push(twoFactorAuthCookie(user, chain.now));
  await addTwoFactorAuthenticatedIp(user, ip);
  resetTwoFactorSession(chain);
  await mergeGuestCartWithUserCart(chain, cartMerge);
  await refreshPasskeySetupPrompt(chain, user);
  return {
    status: 303,
    location: await loginPathFor(chain, user.get("id"), params),
    flash: { notice: "Successfully logged in!" },
    cookies,
  };
}

async function twoFactor(
  input: MutationInput,
  action: (user: UserRecord) => Promise<ActionResult>,
): Promise<ActionResult> {
  const step = await twoFactorUser(input);
  return "halt" in step ? step.halt : action(step.user);
}

const redirectToTwoFactor = (flash?: Record<string, string>): Redirected => ({
  status: 303,
  location: TWO_FACTOR_PATH,
  ...(flash ? { flash } : {}),
});

async function resendToken(chain: Chain, user: UserRecord): Promise<void> {
  await sendAuthenticationToken(currentJobsRuntime(), { id: user.get("id"), email: user.get("email") });
  chain.session.data[TWO_FACTOR_SENT_AT_SESSION_KEY] = nowSeconds(chain);
}

registerMutations(
  { method: "POST", pattern: "/login", options: LOGIN_OPTIONS, run: loginCreate },
  { method: "POST", pattern: "/users/sign_in", options: LOGIN_OPTIONS, run: loginCreate },
  { method: "DELETE", pattern: "/logout", options: LOGOUT_OPTIONS, run: logout },
  { method: "GET", pattern: "/logout", options: LOGOUT_OPTIONS, skipForgeryProtection: true, run: logout },
  { method: "DELETE", pattern: "/users/sign_out", options: LOGOUT_OPTIONS, run: logout },
  {
    method: "POST",
    pattern: "/two-factor",
    options: TWO_FACTOR_OPTIONS,
   
    run: (input) => twoFactor(input, (user) => verifyAuthTokenAndRedirect(input, user)),
  },
  {
    method: "GET",
    pattern: "/two-factor/verify",
    options: TWO_FACTOR_OPTIONS,
    skipForgeryProtection: true,
   
    run: (input) => twoFactor(input, (user) => verifyAuthTokenAndRedirect(input, user)),
  },
  {
    method: "POST",
    pattern: "/two-factor/resend_authentication_token",
    options: TWO_FACTOR_OPTIONS,
   
    run: (input) =>
      twoFactor(input, async (user) => {
        if (twoFactorMethod(input.chain) !== "email")
          return redirectToTwoFactor({ warning: "Cannot resend token for authenticator app." });
        await resendToken(input.chain, user);
        return redirectToTwoFactor({ notice: "Resent the authentication token, please check your inbox." });
      }),
  },
  {
    method: "POST",
    pattern: "/two-factor/switch_to_email",
    options: TWO_FACTOR_OPTIONS,
   
    run: (input) =>
      twoFactor(input, async (user) => {
        input.chain.session.data[TWO_FACTOR_METHOD_SESSION_KEY] = "email";
        await resendToken(input.chain, user);
        return redirectToTwoFactor({ notice: `Authentication token sent to ${user.get("email")}.` });
      }),
  },
  {
    method: "POST",
    pattern: "/two-factor/switch_to_recovery",
    options: TWO_FACTOR_OPTIONS,
   
    run: (input) =>
      twoFactor(input, async () => {
        input.chain.session.data[TWO_FACTOR_METHOD_SESSION_KEY] = "recovery";
        return redirectToTwoFactor();
      }),
  },
  {
    method: "POST",
    pattern: "/two-factor/switch_to_authenticator",
    options: TWO_FACTOR_OPTIONS,
   
    run: (input) =>
      twoFactor(input, async () => {
        input.chain.session.data[TWO_FACTOR_METHOD_SESSION_KEY] = "totp";
        return redirectToTwoFactor();
      }),
  },
);
