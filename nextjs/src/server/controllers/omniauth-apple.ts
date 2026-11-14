// Sign in with Apple (omniauth-apple over OmniAuth::Strategies::OAuth2, with the nonce-cookie patch of config/initializers/005_apple.rb): the
// request phase (the redirect to Apple and the signed `_apple_oauth_nonce` cookie) and the form_post callback that carries a code and an
// id_token.
//
// The callback verifies the id_token (Apple's JWKS, RS256, iss, aud, iat, exp, nonce) before the code is exchanged, because the gem builds its
// client from the id_token's audience. That makes every decision about the account possible before the code is spent, so a sign-in Node does
// not finish (an account to create or change) is handed back to Rails ahead of the exchange. What Node finishes is the sign-in of a user who
// already has an Apple identity and nothing to update. A failure ends in the failure action, which Rails runs with a null session (the POST has
// no CSRF token): a redirect to the login page with no cookies written, which is why the flash is not reproduced.
import { createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { Prisma } from "@prisma/client";

import { railsMessageVerifierGenerate, railsMessageVerifierVerified } from "../auth/message-verifier.ts";
import { getConfig } from "../infra/config.ts";
import { outboundFetch } from "../infra/outbound-http.ts";
import { type AppleData, applyAppleSignIn, planAppleSignIn } from "../models/social-apple.ts";
import { selectRows, column, table } from "../models/sql.ts";
import { findUser, isDeleted } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { signedInUserHome } from "./auth-pages.ts";
import { signIn } from "./auth-session.ts";
import { faradayQuery } from "./faraday-query.ts";
import { type MutationInput, registerMutations, remoteIp } from "./mutation.ts";
import {
  assertHtml,
  BARE,
  fullHost,
  isHash,
  oauthFailure,
  queryParams,
  sessionHash,
  stringParam,
} from "./omniauth-phases.ts";
import { safeRedirectPath } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import {
  accessTokenFrom,
  NotPorted,
  oauthParsed,
  oauthRequest,
  OAuth2Error,
  StrategyFailure,
} from "./social-connect-exchange.ts";

const ISSUER = "https://appleid.apple.com";
const REQUEST_PATH = "/users/auth/apple";
const CALLBACK_PATH = `${REQUEST_PATH}/callback`;
const COOKIE_NAME = "_apple_oauth_nonce";
const COOKIE_PURPOSE = "apple_oauth";
const COOKIE_TTL_SECONDS = 300;
const STATE_BYTES = 24;
const NONCE_BYTES = 32;
const CLIENT_SECRET_TTL_SECONDS = 60;
const FOUND = 302;
const SIGN_IN_PATH = "/users/sign_in";
const LOGIN_PATH = "/login";
const SIGNUP_PATH = "/signup";
const DELETED_ACCOUNT_LOGIN_ERROR =
  "You cannot log in because your account was deleted. Email support@gumroad.com if you'd like to use this email address for a new account.";
const SCOPE = "email name";

// A callback that ends in the failure action. The form POST has no CSRF token, so Rails runs the action with a null session and only the
// redirect goes out; the GET has no check to fail, so the flash is written.
class AppleFailure extends Error {}

const CLAIMS = ["iss", "aud", "iat", "exp", "nonce"];
const LIBRARY_FAILURES: Record<string, { type: string; reason: string } | undefined> = {
  signature: { type: "id_token_signature_invalid", reason: "JSON::JWS::VerificationFailed" },
  "kid not found": { type: "jwks_fetching_failed", reason: "JSON::JWK::Set::KidNotFound" },
};
const KIND = "Apple";

const callbackFailure = (input: MutationInput, failure?: AppleFailure): ActionResult => {
  if (input.request.method !== "GET") {
    input.chain.bare = true;
    return { status: FOUND, location: SIGN_IN_PATH };
  }
  if (failure === undefined) return oauthFailure(KIND, input, "invalid_credentials", null);
  // verify_claims! raises CallbackError(:id_token_claims_invalid, "<claim> invalid"). A signature or key id failure carries the class name of
  // the JSON::JWT exception as its reason; a refused JWKS call carries a message with an object address, which is handed back.
  if (CLAIMS.includes(failure.message))
    return oauthFailure(KIND, input, "id_token_claims_invalid", `${failure.message} invalid`);
  const library = LIBRARY_FAILURES[failure.message];
  if (library === undefined)
    throw new HandBackToRails(`an id_token failure (${failure.message}) with a library message`);
  return oauthFailure(KIND, input, library.type, library.reason);
};

// SecureRandom.hex / urlsafe_base64
async function randomValue(bytes: number, encoding: "hex" | "base64url"): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  return randomBytes(bytes).toString(encoding);
}

const redirectUri = () => `${fullHost()}${CALLBACK_PATH}`;

// The strategy's client secret: JSON::JWT signed ES256 with the key id as `kid`. `sub` is the client id the strategy resolved, which is nil once
// an id_token was verified (authorized_client_ids is empty), as Rails sends it.
export function appleClientSecret(now: Date, clientId: string | null): string {
  const pem = getConfig("APPLE_WEB_PRIVATE_KEY");
  const team = getConfig("APPLE_WEB_TEAM_ID");
  const keyId = getConfig("APPLE_WEB_KEY_ID");
  if (!pem || !team || !keyId) throw new HandBackToRails("no Apple sign-in key configured");
  const seconds = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signing = `${encode({ typ: "JWT", alg: "ES256", kid: keyId })}.${encode({ iss: team, aud: ISSUER, sub: clientId, iat: seconds, exp: seconds + CLIENT_SECRET_TTL_SECONDS })}`;
  const signature = cryptoSign("sha256", Buffer.from(signing), {
    key: createPrivateKey(pem.replaceAll("\\n", "\n")),
    dsaEncoding: "ieee-p1363",
  });
  return `${signing}.${signature.toString("base64url")}`;
}

type IdToken = Record<string, unknown>;

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (isHash(value)) return value;
  } catch {
    // falls through
  }
  throw new HandBackToRails("an id_token JSON::JWT cannot decode");
}

// JSON::JWK::Set::Fetcher.fetch(ISSUER/auth/keys, kid:) then JSON::JWT#verify! then verify_claims!. Any failure of the fetch or the checks is
// a CallbackError (the failure action); a token this port cannot judge as Ruby does is handed back.
async function verifyIdToken(token: string, cookieNonce: string | null, now: Date, clientId: string): Promise<IdToken> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new HandBackToRails("an id_token that is not a compact JWS");
  const header = decodeSegment(segments[0]!);
  const claims = decodeSegment(segments[1]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    throw new HandBackToRails("an id_token that is not RS256 with a key id");

  let key;
  try {
    const answer = await outboundFetch(`${ISSUER}/auth/keys`);
    if (answer.status !== 200) throw new AppleFailure("jwks");
    const keys = (JSON.parse(await answer.text()) as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) throw new HandBackToRails("a JWKS without keys");
    const jwk = (keys as Record<string, unknown>[]).find((candidate) => candidate.kid === header.kid);
    if (jwk === undefined) throw new AppleFailure("kid not found");
    if (jwk.kty !== "RSA") throw new HandBackToRails("a JWK that is not RSA");
    key = createPublicKey({ key: jwk as never, format: "jwk" });
  } catch (error) {
    if (error instanceof HandBackToRails || error instanceof AppleFailure) throw error;
    throw new AppleFailure("jwks fetching failed");
  }
  const valid = cryptoVerify(
    "sha256",
    Buffer.from(`${segments[0]}.${segments[1]}`),
    key,
    Buffer.from(segments[2]!, "base64url"),
  );
  if (!valid) throw new AppleFailure("signature");

  const seconds = Math.floor(now.getTime() / 1000);
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number")
    throw new HandBackToRails("an id_token without numeric iat and exp");
  if (claims.iss !== ISSUER) throw new AppleFailure("iss");
  if (claims.aud !== clientId) throw new AppleFailure("aud");
  if (!(claims.iat <= seconds)) throw new AppleFailure("iat");
  if (!(claims.exp >= seconds)) throw new AppleFailure("exp");
  const supported = claims.nonce_supported;
  if (supported !== undefined && supported !== null && supported !== false) {
    if (!claims.nonce || claims.nonce !== cookieNonce) throw new AppleFailure("nonce");
  }
  return claims;
}

async function requestPhase(input: MutationInput): Promise<ActionResult> {
  assertHtml(input);
  const { session } = input.chain;
  const clientId = getConfig("APPLE_WEB_CLIENT_ID");
  if (!clientId) throw new HandBackToRails("no Apple client id configured");
  // The client is built for the redirect, which signs a client secret; a key that cannot sign is a 500 in Rails.
  appleClientSecret(input.chain.now, clientId);

  const state = await randomValue(STATE_BYTES, "hex");
  const nonce = await randomValue(NONCE_BYTES, "base64url");
  const params = queryParams(input.url);
  session.data["omniauth.params"] = params;
  const origin = stringParam(input, "origin");
  const referer = input.request.headers.get("referer");
  if (origin !== undefined) session.data["omniauth.origin"] = origin;
  else if (referer !== null && !new RegExp(`${REQUEST_PATH}$`, "mu").test(referer))
    session.data["omniauth.origin"] = referer;
  session.data["omniauth.state"] = state;

  const location = `${ISSUER}/auth/authorize?${faradayQuery({
    redirect_uri: redirectUri(),
    response_mode: "form_post",
    scope: SCOPE,
    state,
    nonce,
    client_id: clientId,
    response_type: "code",
  })}`;
  const cookieData: Record<string, string> = { nonce };
  const requestedReferer = input.params.referer;
  if (requestedReferer !== undefined && requestedReferer !== null && requestedReferer !== false) {
    if (typeof requestedReferer !== "string") throw new HandBackToRails("a referer that is not a string");
    if (isPresent(requestedReferer)) cookieData.referer = requestedReferer;
  }
  const signed = railsMessageVerifierGenerate("apple_oauth", cookieData, COOKIE_PURPOSE, {
    expiresAt: new Date(input.chain.now.getTime() + COOKIE_TTL_SECONDS * 1000),
  });
  const { setCookieHeader } = await import("./rack-cookies.ts");
  const secure = input.request.protocol === "https:";
  const cookie = setCookieHeader(COOKIE_NAME, {
    value: signed,
    path: REQUEST_PATH,
    maxAge: COOKIE_TTL_SECONDS,
    secure,
    httpOnly: true,
    sameSite: "none",
  });
  return {
    status: FOUND,
    body: `Redirecting to ${location}...`,
    contentType: "",
    headers: { location },
    cookies: [cookie],
  };
}

type AppleUserRow = { user_id: bigint };

// The user's Apple identity: `UserExternalAuthentication.find_by(provider: "apple", uid:)&.user`.
async function appleUserId(uid: string): Promise<bigint | null> {
  const rows = await selectRows<AppleUserRow>(
    Prisma.sql`SELECT ${column("user_external_authentications", "user_id")} FROM ${table("user_external_authentications")} WHERE ${column("user_external_authentications", "provider")} = 'apple' AND ${column("user_external_authentications", "uid")} = ${uid} ORDER BY ${column("user_external_authentications", "id")} LIMIT 1`,
  );
  return rows[0]?.user_id ?? null;
}

// The strategy's `info[:name]`: `[first_name, last_name].compact.join(" ")` from `request.params["user"]`, which Apple posts once as JSON; nil
// once pruned. Only a shape the gem's `info` block survives is accepted.
function appleName(input: MutationInput): string | null {
  const raw = input.params.user;
  if (raw === undefined || raw === null) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!isHash(parsed)) throw new HandBackToRails("a user parameter that is not an object");
  const name = parsed.name;
  if (name === undefined || name === null) return null;
  if (!isHash(name)) throw new HandBackToRails("a user name that is not an object");
  const parts = [name.firstName, name.lastName].filter((part) => part !== undefined && part !== null);
  if (parts.some((part) => typeof part !== "string")) throw new HandBackToRails("a name part that is not a string");
  const joined = (parts as string[]).join(" ");
  return joined === "" ? null : joined;
}

// The strategy's `info` for the claims of a verified id_token.
function appleData(claims: IdToken, uid: string, name: string | null): AppleData {
  const email = claims.email;
  if (email !== undefined && email !== null && typeof email !== "string")
    throw new HandBackToRails("an id_token email that is not a string");
  const verified = claims.email_verified;
  return {
    uid,
    email: email === undefined || email === null || email === "" ? null : email,
    emailVerified: verified === true || verified === "true",
    name,
  };
}

// OmniAuth::Strategies::OAuth2#callback_phase on `error`/`error_reason`, before any token is looked at: the same failure type and reason as
// the other OAuth 2 strategies, with the session entries of the request phase spent.
function deniedCallback(input: MutationInput): ActionResult {
  const error = stringParam(input, "error_reason") ?? stringParam(input, "error");
  // A blank string is truthy in Ruby, so it still fails the callback.
  if (error === undefined) throw new HandBackToRails("an error that is not a string");
  delete input.chain.session.data["omniauth.origin"];
  delete input.chain.session.data["omniauth.params"];
  const reason =
    stringParam(input, "error_description") ?? stringParam(input, "error_reason") ?? stringParam(input, "error");
  return oauthFailure(KIND, input, error, reason ?? error);
}

async function callbackPhase(input: MutationInput): Promise<ActionResult> {
  assertHtml(input);
  const { chain } = input;
  const saved = structuredClone(chain.session.data);
  try {
    if (
      chain.auth.context.loggedInUser ||
      chain.auth.effects.signOut ||
      chain.auth.authenticatedVia === "remember_cookie"
    )
      throw new HandBackToRails("a visitor who is signed in");
    const errored = input.params.error !== undefined || input.params.error_reason !== undefined;
    if (errored && input.request.method !== "GET") throw new HandBackToRails("a callback that carries an error");
    if (errored) return deniedCallback(input);
    const token = stringParam(input, "id_token");
    const code = stringParam(input, "code");
    const clientId = getConfig("APPLE_WEB_CLIENT_ID");
    if (token === undefined || !isPresent(token) || code === undefined || !isPresent(code) || !clientId)
      throw new HandBackToRails("a callback without an id_token or a code");

    // callback_call: the session's OmniAuth entries are spent, then the cookie's data replaces the params.
    const sessionParams = sessionHash(chain, "omniauth.params");
    const origin = chain.session.data["omniauth.origin"];
    delete chain.session.data["omniauth.origin"];
    delete chain.session.data["omniauth.params"];
    const cookieValue = input.request.cookies.get(COOKIE_NAME);
    const cookie =
      typeof cookieValue === "string"
        ? railsMessageVerifierVerified("apple_oauth", cookieValue, COOKIE_PURPOSE, chain.now)
        : null;
    const cookieData = isHash(cookie) ? cookie : null;
    const omniauthParams: Record<string, unknown> = cookieData ? { ...cookieData } : sessionParams;
    if (cookieData) delete omniauthParams.nonce;

    let claims: IdToken;
    try {
      claims = await verifyIdToken(
        token,
        typeof cookieData?.nonce === "string" ? cookieData.nonce : null,
        chain.now,
        clientId,
      );
    } catch (error) {
      if (error instanceof AppleFailure) return callbackFailure(input, error);
      throw error;
    }

    // find_or_create_for_apple_oauth: every case is judged here, before the code is spent.
    const uid = claims.sub;
    if (typeof uid !== "string" || uid === "") throw new HandBackToRails("an id_token without a subject");
    const userId = await appleUserId(uid);
    const identityUser = userId === null ? null : await findUser(userId);
    if (userId !== null && identityUser === null) throw new HandBackToRails("an Apple identity whose user is gone");
    const plan = await planAppleSignIn(appleData(claims, uid, appleName(input)), identityUser);
    const ip = remoteIp(input.request);
    if (ip === null) throw new HandBackToRails("a request with no client address");

    // From here the code is spent.
    const exchanged = await exchange(code, chain.now);
    if (!exchanged) return callbackFailure(input);

    const user = plan.kind === "user" ? await applyAppleSignIn(plan, () => chain.now) : null;
    if (user === null) {
      return {
        status: FOUND,
        location: SIGNUP_PATH,
        flash: { alert: "Sorry, something went wrong. Please try again." },
      };
    }
    if (isDeleted(user)) return { status: FOUND, location: LOGIN_PATH, flash: { alert: DELETED_ACCOUNT_LOGIN_ERROR } };

    const cookies = await signIn(chain, user, { remember: false, remoteIp: ip });
    // post_auth_redirect
    const { rootDomain } = domainConfig(process.env);
    const requested = stringParam(input, "referer");
    const referer = requested !== undefined && isPresent(requested) ? requested : (omniauthParams.referer ?? origin);
    const target =
      typeof referer === "string" && isPresent(referer) && referer !== "/"
        ? referer
        : await signedInUserHome(user.get("id"));
    const once = safeRedirectPath(target, chain.request, { rootDomain });
    return { status: FOUND, location: safeRedirectPath(once, chain.request, { rootDomain }), cookies };
  } catch (error) {
    if (error instanceof HandBackToRails) chain.session.data = saved;
    throw error;
  }
}

// OmniAuth::Strategies::OAuth2#build_access_token for Apple: the form is client_secret, code, grant_type and redirect_uri, with no client id
// (the strategy resolved none). True when the access token is usable.
async function exchange(code: string, now: Date): Promise<boolean> {
  const form = faradayQuery({
    client_secret: appleClientSecret(now, null),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  try {
    const answer = await oauthRequest(`${ISSUER}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const parsed = oauthParsed(answer.contentType, answer.text);
    if (!isHash(parsed) || Object.keys(parsed).length === 0) throw new OAuth2Error("no token answer");
    const accessToken = accessTokenFrom(parsed, now);
    if (accessToken.expiresAt !== null && accessToken.expiresAt <= Math.floor(now.getTime() / 1000))
      throw new NotPorted("an Apple access token that is expired when it arrives");
    return true;
  } catch (error) {
    if (error instanceof OAuth2Error || error instanceof StrategyFailure) return false;
    throw error;
  }
}

registerMutations(
  { method: "POST", pattern: REQUEST_PATH, options: BARE, run: requestPhase },
  { method: "POST", pattern: CALLBACK_PATH, skipForgeryProtection: true, run: callbackPhase },
  { method: "GET", pattern: CALLBACK_PATH, skipForgeryProtection: true, run: callbackPhase },
);
