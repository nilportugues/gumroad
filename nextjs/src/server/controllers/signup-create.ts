// SignupController#create (POST /signup, and /users on the Devise route): `handle_existing_users` ahead of the action, then the account is
// built from the permitted `user` params, saved (bcrypt digest, confirmation token, User's callbacks, the confirmation mail and
// GenerateUsernameJob after commit), signed in, recorded as a SignupEvent and remembered for two-factor authentication.
//
// Whatever the port cannot prove goes to Rails before the first write: a signed-in visitor, a purchase to attach, a card token, a referral,
// the remember-me checkbox, a Canadian address (GeoIP flips a notification flag), a parameter that is not plain text, an unconfirmed
// existing account (Devise's activatable hook refuses it), a guest cart to merge and a request that asks for neither HTML nor JSON.
import { db } from "../../lib/db.ts";
import { validPassword } from "../auth/devise-password.ts";
import { isBlank } from "../html/text-helper.ts";
import { geoIpLookup } from "../infra/geo-ip.ts";
import {
  DELETED_ACCOUNT_HOLDS_EMAIL_ERROR,
  findUser,
  isFlagSet,
  passwordIsPwned,
  setFlag,
  setPassword,
  Users,
} from "../models/user.ts";
import { createUserEvent } from "../page-props/audience/events.ts";

import { type ActionResult, HandBackToRails, type Rendered, type Redirected } from "./application-controller.ts";
import {
  assertConfirmed,
  loginPathFor,
  prepareTwoFactorAuthentication,
  requireSignedOut,
  resetTwoFactorSession,
} from "./auth-mutations.ts";
import {
  addTwoFactorAuthenticatedIp,
  assertNoGuestCart,
  refreshPasskeySetupPrompt,
  rememberedTwoFactor,
  signIn,
  twoFactorAuthCookie,
} from "./auth-session.ts";
import { jsonResponse } from "./json-seller.ts";
import { type MutationInput, registerMutations, remoteIp } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";

const SIGNUP_PATH = "/signup";
const SEE_OTHER = 303;
const FOUND = 302;
const INVALID_EMAIL_MESSAGE = "Please provide a valid email address.";
const PASSWORD_MISSING_MESSAGE = "Please provide a password.";
const EXISTING_ACCOUNT_MESSAGE = "An account already exists with this email.";
const PWNED_PASSWORD_WARNING =
  "Your password has previously appeared in a data breach as per haveibeenpwned.com and should never be used. We strongly recommend you change your password everywhere you have used it.";
const CANADA = "CA";
// The `user` keys SignupController#permitted_params keeps; the rest never reach User.new.
const CARD_PARAMS = ["stripe_token", "stripe_payment_method_id"];

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `Object#present?` for a value a form or JSON body can carry.
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return !isBlank(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isHash(value)) return Object.keys(value).length > 0;
  return true;
}

// A param Rails would read as a String (or nil); anything else is a shape the port leaves to Rails.
function textParam(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new HandBackToRails("a parameter that is not a string");
}

type Answer = "html" | "json";

function answerFormat(input: MutationInput): Answer {
  const format = requestFormat(input.chain.request);
  if (format === "other") throw new HandBackToRails("a request that accepts neither HTML nor JSON");
  return format;
}

// redirect_with_signup_error / the JSON failure.
// `halted`: handle_existing_users answered ahead of the action, so the after_actions (the XSRF-TOKEN cookie) did not run.
function failure(format: Answer, message: string, halted = false): ActionResult {
  if (format === "json")
    return {
      ...jsonResponse({ success: false, error_message: message }, 200, true),
      ...(halted ? { rescued: true } : {}),
    };
  const redirected: Redirected = {
    status: SEE_OTHER,
    location: SIGNUP_PATH,
    flash: { warning: message },
    ...(halted ? { rescued: true } : {}),
  };
  return redirected;
}

function success(
  format: Answer,
  location: string,
  cookies: string[],
  flash?: Record<string, string>,
  halted = false,
): ActionResult {
  if (format === "json") {
    const rendered: Rendered = {
      ...jsonResponse({ success: true, redirect_location: location }, 200, true),
      cookies,
      ...(halted ? { rescued: true } : {}),
    };
    return rendered;
  }
  return { status: FOUND, location, cookies, ...(flash ? { flash } : {}), ...(halted ? { rescued: true } : {}) };
}

function clientIp(input: MutationInput): string {
  const ip = remoteIp(input.request);
  if (ip === null) throw new HandBackToRails("a request with no client address");
  return ip;
}

// handle_existing_users for an address that already has an account: the owner of the password signs in, anyone else is refused.
async function existingAccount(
  input: MutationInput,
  format: Answer,
  email: string,
  password: string,
): Promise<ActionResult | null> {
  const holders = await db.user.findMany({ where: { email }, orderBy: { id: "asc" } });
  if (holders.length === 0) return null;
  const holder = holders.find((row) => row.deleted_at === null) ?? holders[0]!;

  if (holder.deleted_at === null && (await validPassword(holder.encrypted_password, password))) {
    const { chain, params } = input;
    const user = await findUser(holder.id);
    if (user === null) throw new HandBackToRails("a user that vanished");
    assertConfirmed(user);
    const ip = clientIp(input);
    const cookies: string[] = [];
    let signedIn = false;
    const remembered = isFlagSet(user, "two_factor_authentication_enabled")
      ? await rememberedTwoFactor(chain, user, ip)
      : { skip: true, cookies: [] as string[] };
    if (remembered.skip) {
      await assertNoGuestCart(chain);
      cookies.push(...remembered.cookies, ...(await signIn(chain, user, { remember: false, remoteIp: ip })));
      signedIn = true;
      resetTwoFactorSession(chain);
      await refreshPasskeySetupPrompt(chain, user);
    } else {
      await prepareTwoFactorAuthentication(chain, user, params);
    }
    // devise-pwned_password's after_set_user hook checks the password the form sent once the user is signed in.
    const flash = signedIn && (await passwordIsPwned(password)) ? { warning: PWNED_PASSWORD_WARNING } : undefined;
    return success(format, await loginPathFor(chain, user.get("id"), params), cookies, flash, true);
  }
  return failure(
    format,
    holders.every((row) => row.deleted_at !== null) ? DELETED_ACCOUNT_HOLDS_EMAIL_ERROR : EXISTING_ACCOUNT_MESSAGE,
    true,
  );
}

async function signupCreate(input: MutationInput): Promise<ActionResult> {
  const { chain, params, request, context, url } = input;
  const format = answerFormat(input);
  const userParams = params.user;
  // user_params?: only a nested hash is ActionController::Parameters.
  if (!isHash(userParams)) return failure(format, INVALID_EMAIL_MESSAGE, true);

  // Parameters whose handling stays in Rails, before any write.
  if (isPresent(params.referral)) throw new HandBackToRails("a referral, which records an invite");
  if (isPresent(userParams.purchase_id)) throw new HandBackToRails("a purchase to attach to the new account");
  if (CARD_PARAMS.some((name) => isPresent(userParams[name]))) throw new HandBackToRails("a card token to save");
  if ("remember_me" in userParams) throw new HandBackToRails("the remember-me checkbox");
  if (Object.keys(userParams).length === 0)
    throw new HandBackToRails("an empty user hash, which ParameterMissing answers");

  const email = textParam(userParams.email);
  const password = textParam(userParams.password);
  const confirmation = textParam(userParams.password_confirmation);
  for (const name of ["terms_accepted", "buyer_signup"] as const)
    if (isHash(userParams[name]) || Array.isArray(userParams[name]))
      throw new HandBackToRails("a permitted key holding a list or hash");

  if (password !== null && !isBlank(password) && email !== null && !isBlank(email)) {
    const existing = await existingAccount(input, format, email, password);
    if (existing !== null) return existing;
  }

  const ip = clientIp(input);
  const geo = geoIpLookup(ip);
  if (geo?.countryCode === CANADA) throw new HandBackToRails("a Canadian address, which turns announcements off");

  const user = Users.build({ email: email ?? "" });
  await setPassword(user, password, confirmation === null ? undefined : confirmation);
  user.set("account_created_ip", ip);
  if (isPresent(userParams.buyer_signup)) setFlag(user, "buyer_signup", true);
  if (isPresent(userParams.terms_accepted)) user.ivars.new_tos_agreement_ips = [ip];

  if (!(await Users.save(user))) {
    const message =
      email === null || isBlank(email)
        ? INVALID_EMAIL_MESSAGE
        : password === null || isBlank(password)
          ? PASSWORD_MISSING_MESSAGE
          : (user.errors.fullMessages()[0] ?? "");
    return failure(format, message);
  }

  const cookies = await signIn(chain, user, { remember: false, remoteIp: ip });
  await createUserEvent("signup", {
    context,
    headers: request.headers,
    url,
    state: input.peekState(),
    params,
    signup: { userId: user.get("id") },
  });
  // remember_two_factor_auth: a new account does not need two-factor authentication.
  cookies.push(twoFactorAuthCookie(user, chain.now));
  await addTwoFactorAuthenticatedIp(user, ip);

  return success(format, await loginPathFor(chain, user.get("id"), params), cookies);
}

registerMutations({
  method: "POST",
  pattern: "/signup",
  options: { skip: ["check_suspended"], prepended: requireSignedOut },
  formats: ["any"],
  run: signupCreate,
});
