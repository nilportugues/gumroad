// The controller side of the authentication pages: Devise's SessionsController (LoginsController#new)
// and RegistrationsController (SignupController#new), TwoFactorAuthenticationController#show and
// SecureRedirectController#new, as the filters and session writes that run before their page renders.
// Only the GET renders are ported; every POST still goes to Rails.
import { randomBytes } from "node:crypto";

import { db } from "../../lib/db.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { rubyUriParseParts, isInvalidUriError } from "../models/concerns/ruby-uri.ts";
import { UserFlags } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { isBuyer } from "../page-props/signed-in/reads.ts";
import { type ActionOptions, type Chain, type FilterOutcome, HandBackToRails, type Redirected, RoutingError } from "./application-controller.ts";
import { assertFlatQuery, cgiEscape, cgiParse, cgiUnescape, referrer, requestFormat, safeRedirectPath } from "./rails-params.ts";
import { isPresent, queryParam } from "./rails-request.ts";

const NOINDEX_NEXT_PREFIX = "/oauth/authorize";
const TEAM_INVITATIONS_PATH = "/settings/team/invitations";
const WEBAUTHN_CHALLENGE_SESSION_KEY = "webauthn_authentication_challenge";
const WEBAUTHN_CHALLENGE_BYTES = 32;
// WebAuthn.configuration.credential_options_timeout
const WEBAUTHN_TIMEOUT_MS = 120_000;
export const TWO_FACTOR_USER_SESSION_KEY = "verify_two_factor_auth_for";
export const TWO_FACTOR_METHOD_SESSION_KEY = "two_factor_auth_method";
export const TWO_FACTOR_SENT_AT_SESSION_KEY = "two_factor_auth_token_sent_at";
// TwoFactorAuthenticationValidator::RESEND_AUTHENTICATION_TOKEN_COOLDOWN
const RESEND_COOLDOWN_SECONDS = 60;
const VERIFY_TWO_FACTOR_PATH = "/two-factor/verify.html";
export const TWO_FACTOR_EXPIRED_FLASH = "Your login session expired. Please sign in again.";

const config = () => domainConfig(process.env);

// ApplicationController#default_url_options: the request's host (and port), except on the discover
// host, where Rails pins DOMAIN.
function urlBase(chain: Chain): string {
  const { request } = chain;
  const settings = config();
  const host = request.host === settings.validDiscoverRequestHost ? settings.domain : request.hostWithPort;
  return `${settings.protocol}://${host}`;
}

const redirect = (location: string, status = 302, rescued = false): { halt: Redirected } => ({ halt: { status, location, rescued } });

// redirect_to ..., warning: "...": the flash a render shows on the next request.
export function setWarning(chain: Chain, message: string): void {
  chain.session.data.flash = { discard: [], flashes: { warning: message } };
}

const sessionValue = (chain: Chain, key: string): unknown => chain.session.data[key];
export const sessionPresent = (value: unknown) => value !== undefined && value !== null && value !== false && value !== "";

// ApplicationController#request_referrer_is_a_valid_after_login_path?
export function referrerIsValidAfterLoginPath(chain: Chain): boolean {
  const from = referrer(chain.request);
  if (!isPresent(from)) return false;
  const base = urlBase(chain);
  return (
    from !== "/" &&
    from !== `${base}/` &&
    from !== "/signup" &&
    from !== `${base}/signup` &&
    !from.startsWith(`${base}/login`) &&
    !from.startsWith("/login") &&
    !from.startsWith(`${base}/two-factor`)
  );
}

// `params[:next]`: a string, or absent. Bracketed keys would make it an array or hash.
function nextParam(chain: Chain): string | null {
  assertFlatQuery(chain.request.queryString);
  const value = queryParam(chain.request, "next");
  return value ?? null;
}

export const signedInUserHome = async (userId: bigint) => ((await isBuyer(userId)) ? "/library" : "/dashboard");

// Devise's require_no_authentication, as Gumroad overrides it (SilentAlreadySignedInRedirect): a
// signed-in visitor is sent where a login would have sent them.
// `params` are those of a POST (the form's `next` field); a GET reads the query string.
export async function requireNoAuthentication(chain: Chain, params?: Record<string, unknown>): Promise<Redirected | null> {
  const { auth, request } = chain;
  const current = auth.context.loggedInUser ?? auth.effects.signedOut?.user ?? null;
  if (!current) return null;

  const format = requestFormat(request);
  if (format === "other") throw new HandBackToRails();
  // Not a navigational format: Devise lets the request through. A POST then runs its action for a signed-in visitor.
  if (format === "json") {
    if (params) throw new HandBackToRails("a signed-in visitor posting for JSON");
    return null;
  }
  if (auth.effects.signedOut?.impersonating) throw new HandBackToRails();

  const loggedIn = railsLoggedInUser(auth.context) ?? current;
  let next: string | null;
  if (params) {
    const posted = params.next;
    if (posted !== undefined && posted !== null && typeof posted !== "string")
      throw new HandBackToRails("a next parameter that is not text");
    next = (posted as string | null | undefined) ?? null;
  } else next = nextParam(chain);
  // ApplicationController#after_sign_in_path_for; omniauth.origin is never set on a plain GET.
  const home = isPresent(next) ? next : await signedInUserHome(loggedIn.id);
  const location = safeRedirectPath(home, request, { allowSubdomainHost: false, rootDomain: config().rootDomain });
  return { status: 302, location };
}

// OauthApplicationConfig#set_oauth_application
async function setOauthApplication(chain: Chain, next: string | null): Promise<{ halt: Redirected } | { name: string | null }> {
  if (!isPresent(next)) return { name: null };
  let query: string | null;
  try {
    query = rubyUriParseParts(next).query;
  } catch (error) {
    if (isInvalidUriError(error)) return redirect("/login", 302, true);
    throw error;
  }
  if (!isPresent(query)) return { name: null };

  const uid = cgiParse(query).get("client_id")?.[0] ?? null;
  const application = uid === null ? null : await db.oauthApplication.findFirst({ where: { uid, deleted_at: null } });
  return { name: application?.name ?? null };
}

const setNoindexHeader = (chain: Chain, next: string | null) => {
  if (next?.startsWith(NOINDEX_NEXT_PREFIX)) chain.headers.set("x-robots-tag", "noindex");
};

// WebauthnCeremonyVerification#build_webauthn_authentication_options: a fresh challenge that the
// sign-in with a passkey checks against the session.
function webauthnAuthenticationOptions(chain: Chain): Record<string, unknown> {
  const challenge = randomBytes(WEBAUTHN_CHALLENGE_BYTES).toString("base64url");
  chain.session.data[WEBAUTHN_CHALLENGE_SESSION_KEY] = challenge;
  return {
    challenge,
    timeout: WEBAUTHN_TIMEOUT_MS,
    extensions: {},
    allowCredentials: [],
    rpId: config().rootDomain.split(":")[0],
    userVerification: "required",
  };
}

async function loginFilters(chain: Chain): Promise<FilterOutcome> {
  const next = nextParam(chain);
  const application = await setOauthApplication(chain, next);
  if ("halt" in application) return application;

  // block_json_request: only a plain JSON request is refused; an Inertia visit asks for the page.
  if (!chain.request.headers.has("x-inertia") && requestFormat(chain.request) === "json") {
    return { halt: { status: 400, body: "", contentType: "text/html", rescued: true, paramsRead: true } };
  }
  setNoindexHeader(chain, next);

  if (!isPresent(next) && referrerIsValidAfterLoginPath(chain)) {
    return redirect(`/login?next=${cgiEscape(referrer(chain.request)!)}`);
  }
  return { state: { application_name: application.name, passkey_login_options: webauthnAuthenticationOptions(chain) } };
}

async function signupFilters(chain: Chain): Promise<FilterOutcome> {
  if (!chain.request.headers.has("x-inertia") && requestFormat(chain.request) !== "html") throw new HandBackToRails();
  const next = nextParam(chain);
  const application = await setOauthApplication(chain, next);
  if ("halt" in application) return application;
  setNoindexHeader(chain, next);
  return { state: { application_name: application.name } };
}

// ApplicationController#login_path_for for a user who is already signed in, with no pending
// two-factor login in the session.
async function loginPathFor(chain: Chain, userId: bigint): Promise<string> {
  const next = nextParam(chain);
  let final: string;
  if (isPresent(next)) final = cgiUnescape(next);
  else if (referrerIsValidAfterLoginPath(chain)) final = referrer(chain.request)!;
  else final = await signedInUserHome(userId);

  const safe = safeRedirectPath(final, chain.request, { rootDomain: config().rootDomain });
  // The login link of a two-factor email goes straight to its verification.
  if (safe.startsWith(VERIFY_TWO_FACTOR_PATH)) return safe;
  // A pending two-factor login in the session decides where the visitor goes, and may be reset.
  if (sessionPresent(sessionValue(chain, TWO_FACTOR_USER_SESSION_KEY))) throw new HandBackToRails();
  return safe;
}

async function twoFactorFilters(chain: Chain): Promise<FilterOutcome> {
  const { auth, request } = chain;

  // redirect_to_signed_in_path: a signed-in visitor who needs no second factor.
  const signedIn = railsLoggedInUser(auth.context);
  if (auth.context.loggedInUser && signedIn) {
    // Whether a remembered browser or IP skips the challenge needs the encrypted 2FA cookie and
    // Redis; those users are served by Rails.
    if (UserFlags.isSet(signedIn.flags, "two_factor_authentication_enabled")) throw new HandBackToRails();
    return redirect(await loginPathFor(chain, signedIn.id), 303, true);
  }

  // fetch_user: User.find raises RecordNotFound for a user that no longer exists.
  const userId = sessionValue(chain, TWO_FACTOR_USER_SESSION_KEY);
  const user = sessionPresent(userId) ? await db.user.findUnique({ where: { id: BigInt(userId as number | string) } }) : null;
  if (sessionPresent(userId) && !user) throw new RoutingError("Not Found");

  if (!user) {
    // redirect_to_login_path: the page asked for rides along as `next`.
    setWarning(chain, TWO_FACTOR_EXPIRED_FLASH);
    const fullpath = request.queryString === "" ? request.path : `${request.path}?${request.queryString}`;
    return redirect(`/login?next=${cgiEscape(fullpath)}`, 303, true);
  }

  const method = sessionValue(chain, TWO_FACTOR_METHOD_SESSION_KEY);
  const sentAt = sessionValue(chain, TWO_FACTOR_SENT_AT_SESSION_KEY);
  return {
    state: {
      user_id: encrypt(user.external_id ?? ""),
      email: user.email,
      two_factor_method: sessionPresent(method) ? method : "email",
      token_sent_at: sessionPresent(sentAt) ? sentAt : null,
      resend_cooldown_seconds: resendCooldownSeconds(sentAt, chain.now),
    },
  };
}

// TwoFactorAuthenticationValidator#resend_authentication_token_cooldown_seconds
export function resendCooldownSeconds(sentAt: unknown, now: Date): number {
  if (!sessionPresent(sentAt)) return 0;
  return Math.max(RESEND_COOLDOWN_SECONDS - (Math.floor(now.getTime() / 1000) - Number(sentAt)), 0);
}

const SECURE_REDIRECT_DEFAULTS = {
  message: "Please enter the confirmation text to continue to your destination.",
  field_name: "Confirmation text",
  error_message: "Confirmation text does not match",
} as const;

async function secureRedirectFilters(chain: Chain): Promise<FilterOutcome> {
  assertFlatQuery(chain.request.queryString);
  const param = (name: string) => queryParam(chain.request, name) ?? null;

  // validate_params
  if (!isPresent(param("encrypted_payload"))) return redirect("/", 302, true);

  // set_encrypted_params
  const given = (name: keyof typeof SECURE_REDIRECT_DEFAULTS) => {
    const value = param(name);
    return isPresent(value) ? value : SECURE_REDIRECT_DEFAULTS[name];
  };
  return {
    state: {
      encrypted_payload: param("encrypted_payload"),
      message: given("message"),
      field_name: given("field_name"),
      error_message: given("error_message"),
    },
  };
}

export const LOGIN_OPTIONS: ActionOptions = { prepended: requireNoAuthentication, filters: loginFilters };
export const SIGNUP_OPTIONS: ActionOptions = { prepended: requireNoAuthentication, filters: signupFilters };
export const TWO_FACTOR_OPTIONS: ActionOptions = { filters: twoFactorFilters };
export const SECURE_REDIRECT_OPTIONS: ActionOptions = { filters: secureRedirectFilters };

// TeamInvitations: AuthPresenter#retrieve_team_invitation_email. `nextPath` has already parsed.
export function teamInvitationEmail(nextPath: string | null): string | null {
  if (!nextPath?.startsWith(TEAM_INVITATIONS_PATH)) return null;
  const query = rubyUriParseParts(nextPath).query;
  if (query === null) return null;
  assertFlatQuery(query);
  let email: string | null = null;
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = decodeWww(index === -1 ? pair : pair.slice(0, index));
    if (key === "email") email = index === -1 ? null : decodeWww(pair.slice(index + 1));
  }
  return email;
}

function decodeWww(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}
