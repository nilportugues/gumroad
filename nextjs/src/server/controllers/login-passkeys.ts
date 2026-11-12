// Logins::PasskeysController (app/controllers/logins/passkeys_controller.rb): passkey login. POST /login/passkey/options keeps a random
// challenge in the session; POST /login/passkey consumes it, verifies the assertion (services/webauthn-assertion.ts), records the
// counter, signs the user in with a remember cookie and answers where to go.
//
// Handed to Rails whole, before any write: a signed-in visitor whose session the skipped filters would end, a guest cart the merge
// cannot prove (services/merge-carts-service.ts), authenticator data with attested credential or extension data, client data that is not a
// JSON object with a text challenge, a signature OpenSSL would raise on, and a user handle that is neither text nor falsy.
import { createHash, randomBytes } from "node:crypto";

import { db } from "../../lib/db.ts";
import { findUser } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { decodeBase64Url, verifyAssertion } from "../services/webauthn-assertion.ts";

import { type ActionOptions, type ActionResult, type Chain, HandBackToRails } from "./application-controller.ts";
import { loginPathFor, resetTwoFactorSession } from "./auth-mutations.ts";
import { mergeGuestCartWithUserCart, planGuestCart, refreshPasskeySetupPrompt, signIn } from "./auth-session.ts";
import { jsonResponse } from "./json-seller.ts";
import { type MutationInput, registerMutations, remoteIp } from "./mutation.ts";
import { isPresent } from "./rails-request.ts";

const AUTHENTICATION_CHALLENGE_SESSION_KEY = "webauthn_authentication_challenge";
const AUTHENTICATION_ERROR_MESSAGE =
  "We couldn't sign you in with that passkey. Please try again or use your password.";
const UNPROCESSABLE = 422;
const CHALLENGE_BYTES = 32;
const OPTIONS_TIMEOUT_MS = 120_000;
const PUBLIC_KEY_TYPE = "public-key";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;

const config = () => domainConfig(process.env);

// config/initializers/webauthn.rb: the relying party is the host of ROOT_DOMAIN, and every request host (with the domains) is an origin.
const rpId = (): string => config().rootDomain.split(":")[0]!;
const allowedOrigins = (): string[] => {
  const { protocol, domain, rootDomain, validRequestHosts } = config();
  return [...new Set([...validRequestHosts, domain, rootDomain])].map((host) => `${protocol}://${host}`);
};

// The controller skips check_suspended and invalidate_session_if_necessary, so a visitor the chain would sign out (or whose session it
// would end) is one Rails answers differently.
const PASSKEY_OPTIONS: ActionOptions = { skip: ["check_suspended"] };

function assertSessionKept(chain: Chain): void {
  const { effects, context } = chain.auth;
  if (effects.signOut || effects.signedOut || context.impersonatedUser)
    throw new HandBackToRails("a signed-in visitor whose session the skipped filters would have ended");
}

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

function requireRemoteIp(input: MutationInput): string {
  const ip = remoteIp(input.request);
  if (ip === null) throw new HandBackToRails("a request with no client address");
  return ip;
}

const refusal = (): ActionResult =>
  jsonResponse({ success: false, error_message: AUTHENTICATION_ERROR_MESSAGE }, UNPROCESSABLE);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ActionController::Parameters#permit for a scalar key: a string, number, boolean or null passes; a list or hash is dropped.
const scalar = (value: unknown): unknown => (isObject(value) || Array.isArray(value) ? undefined : value);

// #base64url_decoded: a String of the base64url alphabet that Ruby's strict decoder accepts.
function base64urlDecoded(value: unknown): Buffer | null {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) return null;
  return decodeBase64Url(value);
}

// ---- POST /login/passkey/options

function options(input: MutationInput): Promise<ActionResult> {
  return Promise.resolve().then(() => {
    assertSessionKept(input.chain);
    const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");
    input.chain.session.data[AUTHENTICATION_CHALLENGE_SESSION_KEY] = challenge;
    return jsonResponse({
      success: true,
      options: {
        challenge,
        timeout: OPTIONS_TIMEOUT_MS,
        extensions: {},
        allowCredentials: [],
        rpId: rpId(),
        userVerification: "required",
      },
    });
  });
}

// ---- POST /login/passkey

type Assertion = {
  id: string;
  authenticatorData: Buffer;
  clientDataJson: Buffer;
  signature: Buffer;
};

// #assertion_params and PublicKeyCredential.from_client: null when Rails answers with a VerificationError.
function assertionParams(credential: unknown): Assertion | null {
  // params.require(:credential) raises on a blank value and `respond_to?(:permit)` fails for anything but a hash.
  if (!isObject(credential)) return null;
  const id = scalar(credential.id);
  const rawId = scalar(credential.rawId);
  const response = credential.response;
  if (
    scalar(credential.type) !== PUBLIC_KEY_TYPE ||
    base64urlDecoded(id) === null ||
    base64urlDecoded(rawId) === null ||
    !isObject(response)
  )
    return null;
  const authenticatorData = base64urlDecoded(scalar(response.authenticatorData));
  const clientDataJson = base64urlDecoded(scalar(response.clientDataJSON));
  const signature = base64urlDecoded(scalar(response.signature));
  if (authenticatorData === null || clientDataJson === null || signature === null) return null;

  // `encoder.decode(response["userHandle"]) if response["userHandle"]`
  const userHandle = scalar(response.userHandle);
  if (userHandle !== undefined && userHandle !== null && userHandle !== false) {
    if (typeof userHandle !== "string") throw new HandBackToRails("a user handle that is not text");
    if (decodeBase64Url(userHandle) === null) return null;
  }
  // PublicKeyCredential#valid_id?: the raw id has to be the id.
  if (!base64urlDecoded(rawId)!.equals(base64urlDecoded(id)!)) return null;
  return { id: id as string, authenticatorData, clientDataJson, signature };
}

async function create(input: MutationInput): Promise<ActionResult> {
  const { chain } = input;
  assertSessionKept(chain);

  const challenge = chain.session.data[AUTHENTICATION_CHALLENGE_SESSION_KEY];
  Reflect.deleteProperty(chain.session.data, AUTHENTICATION_CHALLENGE_SESSION_KEY);
  if (typeof challenge !== "string" || !isPresent(challenge)) return refusal();

  const assertion = assertionParams(input.params.credential);
  if (assertion === null) return refusal();

  const stored = await db.webauthnCredential.findFirst({
    where: { webauthn_id_sha256: sha256Hex(assertion.id) },
  });
  if (stored === null) return refusal();

  const verdict = verifyAssertion({
    challenge,
    publicKey: stored.public_key,
    storedSignCount: Number(stored.sign_count),
    rpId: rpId(),
    allowedOrigins: allowedOrigins(),
    authenticatorData: assertion.authenticatorData,
    clientDataJson: assertion.clientDataJson,
    signature: assertion.signature,
  });
  if (!verdict.ok) return refusal();

  const user = await findUser(stored.user_id);
  if (user === null) throw new HandBackToRails("a passkey whose user is gone");
  if (user.get("deleted_at") != null) return refusal();
  const cartMerge = await planGuestCart(chain, user);

  const ip = requireRemoteIp(input);
  await db.webauthnCredential.update({
    where: { id: stored.id },
    data: { sign_count: BigInt(verdict.signCount), last_used_at: chain.now, updated_at: chain.now },
  });
  // Devise's sign_in does nothing for the account the browser is already signed in to: no new session, remember cookie or tracked fields.
  const cookies =
    chain.auth.context.loggedInUser?.id === user.get("id")
      ? []
      : await signIn(chain, user, { remember: true, remoteIp: ip });
  resetTwoFactorSession(chain);
  await mergeGuestCartWithUserCart(chain, cartMerge);
  await refreshPasskeySetupPrompt(chain, user);
  const location = await loginPathFor(chain, user.get("id"), input.params);
  return { ...jsonResponse({ success: true, redirect_location: location }), cookies };
}

registerMutations(
  { method: "POST", pattern: "/login/passkey/options", json: true, options: PASSKEY_OPTIONS, run: options },
  { method: "POST", pattern: "/login/passkey", json: true, options: PASSKEY_OPTIONS, run: create },
);
