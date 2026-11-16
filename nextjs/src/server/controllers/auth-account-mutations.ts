// User::PasswordsController (create, update), ConfirmationsController#show, User::InvalidateActiveSessionsController and the
// users routes that answer JSON or redirect with a flash: session_info, current_user_data, check_twitter_link and
// email_unsubscribe. Devise's sign-in is auth-session.ts; the login and two-factor actions are auth-mutations.ts.
//
// Whatever the port cannot prove goes to Rails before the first write: an unconfirmed address that is pending (reconfirmation),
// the signed-in visitor who is impersonating, a guest cart to merge, parameters that are not plain strings, and the unsubscribe
// link of a signed-out visitor holding only an external id (it redirects through SecureEncryptService, whose output is random).
import { db } from "../../lib/db.ts";
import { deviseTokenDigest } from "../auth/devise-token.ts";
import { railsSessionCookieName } from "../auth/rails-session-config.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { WARDEN_SCOPE_SESSION_KEY } from "../auth/warden.ts";
import { isBlank } from "../html/text-helper.ts";
import { deliverLater, record, symbolHash } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { currentJobsRuntime, performAsync } from "../models/concerns/job-runtime.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { decryptSecureExternalId } from "../models/secure-external-id.ts";
import { invalidateActiveSessions } from "../models/user-risk.ts";
import {
  deviseFriendlyToken,
  findUser,
  findUserBang,
  isConfirmed,
  isDeleted,
  isFlagSet,
  isValidEmailFormat,
  passwordIsPwned,
  setFlag,
  setPassword,
  Users,
  type UserRecord,
} from "../models/user.ts";
import { signedInPresenters } from "../page-props/signed-in/presenters.ts";
import { settingsMainUserPolicy } from "../policies/settings/main-user.ts";

import {
  type ActionResult,
  allowedReferrer,
  type Chain,
  HandBackToRails,
  type Redirected,
  RoutingError,
} from "./application-controller.ts";
import { prepareTwoFactorAuthentication, resetTwoFactorSession } from "./auth-mutations.ts";
import { signedInUserHome, TWO_FACTOR_USER_SESSION_KEY } from "./auth-pages.ts";
import {
  assertNoGuestCart,
  refreshPasskeySetupPrompt,
  rememberedTwoFactor,
  signIn,
  signOutUser,
} from "./auth-session.ts";
import { json } from "./json-actions.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { type MutationInput, registerMutations, remoteIp } from "./mutation.ts";
import { cgiEscape } from "./rails-params.ts";

const LOGIN_PATH = "/login";
const ROOT_PATH = "/";
const DEFAULT_REDIRECT_STATUS = 302;
const USER_MAILER = "UserSignupMailer";
const RESET_PASSWORD_WITHIN_MS = 24 * 60 * 60 * 1000;
const INVALID_TOKEN_MESSAGE = "That reset password token doesn't look valid (or may have expired).";
const CONFIRMATION_LINK_STALE =
  "This confirmation link is no longer valid. If you requested a new confirmation email, please use the link in the most recent one.";
const UNSUBSCRIBE_SCOPE = "email_unsubscribe";
const UNSUBSCRIBE_MESSAGES: Record<
  string,
  | {
      flag: "enable_payment_email" | "enable_free_downloads_email" | "announcement_notification_enabled";
      message: string;
    }
  | { weekly: true; message: string }
> = {
  notify: { flag: "enable_payment_email", message: "You have been unsubscribed from purchase notifications." },
  free_downloads: {
    flag: "enable_free_downloads_email",
    message: "You have been unsubscribed from free download notifications.",
  },
  seller_update: { weekly: true, message: "You have been unsubscribed from weekly sales updates." },
  product_update: {
    flag: "announcement_notification_enabled",
    message: "You have been unsubscribed from Gumroad announcements.",
  },
};

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function stringParam(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new HandBackToRails("a parameter that is not a string");
}

const toSeconds = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

function clientIp(input: MutationInput): string {
  const ip = remoteIp(input.request);
  if (ip === null) throw new HandBackToRails("a request with no client address");
  return ip;
}

const flashed = (status: number, location: string, flash: Record<string, string>, cookies?: string[]): Redirected => ({
  status,
  location,
  flash,
  ...(cookies ? { cookies } : {}),
});

// ---- User::PasswordsController -------------------------------------------------------------------------------------------

// Devise::Models::Recoverable#send_reset_password_instructions: a fresh token is stored digested and mailed raw.
async function sendResetPasswordInstructions(chain: Chain, user: UserRecord): Promise<void> {
  let raw: string;
  let digest: string;
  do {
    raw = deviseFriendlyToken();
    digest = deviseTokenDigest("reset_password_token", raw);
  } while ((await db.user.findFirst({ where: { reset_password_token: digest }, select: { id: true } })) !== null);
  user.set("reset_password_token", digest);
  user.set("reset_password_sent_at", toSeconds(chain.now));
  await Users.save(user, { validate: false, now: () => chain.now });
  const method = "reset_password_instructions";
  await deliverLater(
    currentJobsRuntime(),
    {
      mailer: USER_MAILER,
      method,
      args: [record("User", user.get("id")), raw, symbolHash({})],
      queue: "critical",
      waitSeconds: 3,
    },
    mailRoute(USER_MAILER, method),
  );
}

async function forgotPasswordCreate({ chain, params, request }: MutationInput): Promise<ActionResult> {
  const userParams = isHash(params.user) ? params.user : {};
  const email = stringParam(userParams.email);
  const found =
    email !== null && !isBlank(email) && isValidEmailFormat(email)
      ? await db.user.findFirst({ where: { email, deleted_at: null }, orderBy: { id: "asc" } })
      : null;
  const user = found === null ? null : await findUser(found.id);
  if (user !== null) {
    await sendResetPasswordInstructions(chain, user);
    return flashed(303, LOGIN_PATH, { notice: "Password reset sent! Please make sure to check your spam folder." });
  }
  return flashed(DEFAULT_REDIRECT_STATUS, allowedReferrer(request) ?? LOGIN_PATH, {
    warning: "An account does not exist with that email.",
  });
}

type ResetResult = {
  user: UserRecord | null;
  errors: { password: boolean; confirmation: boolean; first: string | null };
};

// User.reset_password_by_token
async function resetPasswordByToken(
  chain: Chain,
  original: string | null,
  password: string | null,
  confirmation: string | null,
): Promise<ResetResult> {
  const failed = (first: string | null = null, flags: Partial<ResetResult["errors"]> = {}): ResetResult => ({
    user: null,
    errors: { password: false, confirmation: false, first, ...flags },
  });
  if (original === null || isBlank(original)) return failed();
  const row = await db.user.findFirst({
    where: { reset_password_token: deviseTokenDigest("reset_password_token", original) },
    orderBy: { id: "asc" },
  });
  if (row === null) return failed();
  const user = await findUser(row.id);
  if (user === null) return failed();
  const sentAt = user.get("reset_password_sent_at");
  if (!(sentAt != null && sentAt.getTime() >= chain.now.getTime() - RESET_PASSWORD_WITHIN_MS)) return failed();
  if (password === null || isBlank(password)) return failed("Password can't be blank", { password: true });
  await setPassword(user, password, confirmation);
  if (await Users.save(user, { now: () => chain.now }))
    return { user, errors: { password: false, confirmation: false, first: null } };
  return failed(user.errors.fullMessages()[0] ?? null, {
    password: user.errors.on("password").length > 0,
    confirmation: user.errors.on("password_confirmation").length > 0,
  });
}

async function forgotPasswordUpdate(input: MutationInput): Promise<ActionResult> {
  const { chain, params } = input;
  const userParams = isHash(params.user) ? params.user : {};
  const token = stringParam(userParams.reset_password_token);
  const password = stringParam(userParams.password);
  const confirmation = stringParam(userParams.password_confirmation);
  // The sign-in that follows a reset merges a guest cart.
  await assertNoGuestCart(chain);

  const result = await resetPasswordByToken(chain, token, password, confirmation);
  if (result.user === null) {
    const message = result.errors.confirmation
      ? "Those two passwords didn't match."
      : result.errors.password
        ? (result.errors.first ?? INVALID_TOKEN_MESSAGE)
        : INVALID_TOKEN_MESSAGE;
    const query = token === null ? "" : `?reset_password_token=${cgiEscape(token)}`;
    return flashed(DEFAULT_REDIRECT_STATUS, `/users/forgot_password/edit${query}`, { warning: message });
  }

  const user = result.user;
  await invalidateActiveSessions(user, () => chain.now);
  if (isDeleted(user)) return flashed(303, ROOT_PATH, { notice: "Your password has been reset." });

  const cookies: string[] = [];
  // sign_in_or_prepare_for_two_factor_auth
  if (isFlagSet(user, "two_factor_authentication_enabled")) {
    const remembered = await rememberedTwoFactor(chain, user, clientIp(input));
    if (!remembered.skip) {
      await prepareTwoFactorAuthentication(chain, user, params);
    } else {
      cookies.push(
        ...remembered.cookies,
        ...(await signIn(chain, user, { remember: false, remoteIp: clientIp(input) })),
      );
      resetTwoFactorSession(chain);
      await refreshPasskeySetupPrompt(chain, user);
      await passwordIsPwned(password!);
    }
  } else {
    cookies.push(...(await signIn(chain, user, { remember: false, remoteIp: clientIp(input) })));
    resetTwoFactorSession(chain);
    await refreshPasskeySetupPrompt(chain, user);
    // devise-pwned_password's after_set_user hook checks the password the form sent.
    await passwordIsPwned(password!);
  }

  if (Number(chain.session.data[TWO_FACTOR_USER_SESSION_KEY]) === Number(user.get("id"))) {
    return flashed(
      303,
      `/two-factor?next=${cgiEscape(ROOT_PATH)}`,
      { notice: "Your password has been reset. Please complete two-factor authentication to continue." },
      cookies,
    );
  }
  return flashed(303, ROOT_PATH, { notice: "Your password has been reset, and you're now logged in." }, cookies);
}

// ---- ConfirmationsController#show ----------------------------------------------------------------------------------------

async function confirmationShow(input: MutationInput): Promise<ActionResult> {
  const { chain, params, context } = input;
  const token = stringParam(params.confirmation_token);
  const found =
    token === null || isBlank(token)
      ? null
      : await db.user.findFirst({ where: { confirmation_token: token }, orderBy: { id: "asc" } });
  if (found === null) return flashed(DEFAULT_REDIRECT_STATUS, ROOT_PATH, { alert: CONFIRMATION_LINK_STALE });
  const user = await findUser(found.id);
  if (user === null) throw new HandBackToRails("a user that vanished");

  // Devise's confirm: an address that is already confirmed is refused, and a pending change of address validates uniqueness.
  if (isConfirmed(user) && isBlank(user.get("unconfirmed_email")))
    return flashed(DEFAULT_REDIRECT_STATUS, ROOT_PATH, { alert: "You have already been confirmed." });
  if (!isBlank(user.get("unconfirmed_email"))) throw new HandBackToRails("a pending reconfirmation");
  if (context.impersonatedUser) throw new HandBackToRails("a confirmation while impersonating");
  const visitor = context.loggedInUser;
  const ip = clientIp(input);

  user.set("confirmed_at", toSeconds(chain.now));
  await Users.save(user, { validate: false, now: () => chain.now });
  // after_confirmation
  user.set("reset_password_token", null);
  user.set("reset_password_sent_at", null);
  await Users.saveBang(user, { validate: false, now: () => chain.now });
  await performAsync("AttachPastPurchasesToUserWorker", [Number(user.get("id")), user.get("email")]);

  const cookies: string[] = [];
  let home: UserRecord = user;
  if (visitor && visitor.id !== user.get("id")) {
    // A creator confirming an account they administer stays signed in as themselves; the confirmed account's browser sessions go.
    await invalidateBrowserSessions(chain, user);
    home = (await findUser(visitor.id))!;
  } else {
    if (!visitor) cookies.push(...(await signIn(chain, user, { remember: false, remoteIp: ip })));
    await invalidateBrowserSessions(chain, user);
    await refreshWardenSignInTime(chain);
  }
  return flashed(
    DEFAULT_REDIRECT_STATUS,
    await signedInUserHome(home.get("id")),
    { notice: "Your account has been successfully confirmed!" },
    cookies,
  );
}

// User#invalidate_browser_sessions!
async function invalidateBrowserSessions(chain: Chain, user: UserRecord): Promise<void> {
  user.set("last_active_sessions_invalidated_at", toSeconds(chain.now));
  await Users.saveBang(user, { validate: false, now: () => chain.now });
}

// ApplicationController#invalidate_active_sessions_except_the_current_session!: the session keeps working with a newer sign-in time.
async function refreshWardenSignInTime(chain: Chain): Promise<void> {
  chain.session.data[WARDEN_SCOPE_SESSION_KEY] = { last_sign_in_at: Math.floor(chain.now.getTime() / 1000) };
}

// ---- User::InvalidateActiveSessionsController ----------------------------------------------------------------------------

async function invalidateActiveSessionsAction(input: MutationInput): Promise<ActionResult> {
  const { chain, context } = input;
  return sellerJsonAction(
    { context, request: input.request },
    settingsMainUserPolicy.invalidateActiveSessions,
    async () => {
      const seller = await findUserBang(context.currentSeller!.id);
      await invalidateActiveSessions(seller, () => chain.now);
      const cookies = await signOutUser(chain, context.loggedInUser!);
      chain.session.data.flash = {
        discard: [],
        flashes: {
          notice: "You have been signed out from all your active sessions. Please login again.",
          notice_style: "success",
        },
      };
      return { ...jsonResponse({ success: true }), cookies };
    },
  );
}

// ---- UsersController: session_info, current_user_data, check_twitter_link, email_unsubscribe -----------------------------

const sessionInfo = async ({ context }: MutationInput): Promise<ActionResult> =>
  json({ success: true, is_signed_in: context.loggedInUser !== null });

async function currentUserData({ context }: MutationInput): Promise<ActionResult> {
  if (context.loggedInUser === null) return json({ success: false }, 401);
  return json({ success: true, user: await signedInPresenters.currentSeller(context) });
}

async function checkTwitterLink({ context }: MutationInput): Promise<ActionResult> {
  const user = railsLoggedInUser(context);
  if (user === null) throw new HandBackToRails("a signed-out visitor on a signed-in endpoint");
  return json({ success: !isBlank(user.twitter_user_id) });
}

async function emailUnsubscribe(input: MutationInput): Promise<ActionResult> {
  const { chain, params, routeParams, context } = input;
  const id = routeParams.id!;
  const secureId = decryptSecureExternalId("User", id, UNSUBSCRIBE_SCOPE, chain.now);
  let user = secureId === null ? null : await findUser(secureId);
  if (user === null) {
    const visitor = railsLoggedInUser(context);
    if (visitor !== null && visitor.external_id === id) user = await findUser(visitor.id);
    else if ((await db.user.findFirst({ where: { external_id: id }, select: { id: true } })) !== null)
      throw new HandBackToRails("an unsubscribe link behind a confirmation text");
    else throw new RoutingError("Not Found");
  }
  if (user === null) throw new RoutingError("Not Found");

  const type = typeof params.email_type === "string" ? UNSUBSCRIBE_MESSAGES[params.email_type] : undefined;
  const flash: Record<string, string> = {};
  if (type) {
    if ("weekly" in type) user.set("weekly_notification", false);
    else setFlag(user, type.flag, false);
    flash.notice = type.message;
  }
  try {
    await Users.saveBang(user, { now: () => chain.now });
  } catch (error) {
    if (error instanceof RecordInvalid) throw new HandBackToRails("an account that fails validation");
    throw error;
  }
  flash.notice_style = "success";
  return flashed(DEFAULT_REDIRECT_STATUS, ROOT_PATH, flash);
}

// POST /mobile/forgot_password on the API host is the same action behind a mobile client that sends no CSRF token, so Rails runs it with a
// null session: nothing is stored in the flash and the response carries no cookie at all. A request that does carry a session or a token is
// one Rails would treat differently, and goes to Rails.
async function mobileForgotPasswordCreate(input: MutationInput): Promise<ActionResult> {
  const { request, params } = input;
  if (
    request.cookies.has(railsSessionCookieName()) ||
    request.headers.has("x-csrf-token") ||
    request.headers.has("x-xsrf-token") ||
    params.authenticity_token !== undefined
  )
    throw new HandBackToRails("a mobile request that carries a session or a CSRF token");
  const result = await forgotPasswordCreate(input);
  if (!("location" in result)) return result;
  const { flash: _flash, ...withoutFlash } = result;
  return withoutFlash;
}

registerMutations(
  {
    method: "POST",
    pattern: "/mobile/forgot_password",
    skipForgeryProtection: true,
    options: { bare: true },
    run: mobileForgotPasswordCreate,
  },
  { method: "POST", pattern: "/users/forgot_password", run: forgotPasswordCreate },
  { method: "PUT", pattern: "/users/forgot_password", run: forgotPasswordUpdate },
  { method: "PATCH", pattern: "/users/forgot_password", run: forgotPasswordUpdate },
  { method: "GET", pattern: "/users/confirmation", skipForgeryProtection: true, run: confirmationShow },
  {
    method: "PUT",
    pattern: "/user/invalidate_active_sessions",
    formats: ["json"],
    run: invalidateActiveSessionsAction,
  },
  {
    method: "PATCH",
    pattern: "/user/invalidate_active_sessions",
    formats: ["json"],
    run: invalidateActiveSessionsAction,
  },
  { method: "GET", pattern: "/users/session_info", skipForgeryProtection: true, run: sessionInfo },
  { method: "GET", pattern: "/users/current_user_data", skipForgeryProtection: true, run: currentUserData },
  { method: "GET", pattern: "/users/check_twitter_link", skipForgeryProtection: true, run: checkTwitterLink },
  { method: "GET", pattern: "/users/unsubscribe/:id", skipForgeryProtection: true, run: emailUnsubscribe },
);
