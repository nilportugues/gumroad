// Settings::PasskeysController (app/controllers/settings/passkeys_controller.rb), a Sellers::BaseController JSON controller: a request
// that does not ask for JSON goes to Rails.
//
// Ported: the owner-only 401, the 403 without an email, the 404 of an unknown passkey, #registration_options (a random challenge kept in
// the session), #create (the attestation checked against that challenge, services/webauthn-attestation.ts), #update (rename) and
// #destroy.
// Handed to Rails before the first write: an attestation Node does not verify (a signed format, a key that is not ES256, shapes where
// the gem raises something Rails does not rescue) and a nickname that is not text.
import { createHash, randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { findUser } from "../models/user.ts";
import { iso8601 } from "../page-props/communities/communities.ts";
import { displayName } from "../page-props/signed-in/presenters.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { settingsPasskeysUserPolicy } from "../policies/settings/passkeys-user.ts";
import { decodeBase64Url } from "../services/webauthn-assertion.ts";
import { type AttestationObject, parseAttestationObject, verifyAttestation } from "../services/webauthn-attestation.ts";
import { allowedOrigins, rpId } from "../services/webauthn-relying-party.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { refreshPasskeySetupPrompt } from "./auth-session.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const UNPROCESSABLE = 422;
const MAX_PER_USER = 10;
const MAX_NICKNAME_LENGTH = 100;
const MAX_WEBAUTHN_ID_LENGTH = 1_364;
const CREATED = 201;
const CHALLENGE_BYTES = 32;
const OPTIONS_TIMEOUT_MS = 120_000;
const PUBLIC_KEY_TYPE = "public-key";
const REGISTRATION_CHALLENGE_SESSION_KEY = "webauthn_registration_challenge";
const REGISTRATION_ERROR_MESSAGE = "Could not add this passkey. Please try again.";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;
// RelyingParty::DEFAULT_ALGORITHMS as COSE ids: ES256, PS256, RS256.
const COSE_ALGORITHMS = [-7, -37, -257];
// WebauthnCredential::AAGUID_PROVIDER_NAMES
const AAGUID_PROVIDER_NAMES: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "fdb141b2-5d84-443e-8a35-4698c205a502": "KeePassXC",
};
const MAX_PER_USER_ERROR_MESSAGE = `You can add up to ${MAX_PER_USER} passkeys.`;
const UPDATE_ERROR_MESSAGE = "Could not update this passkey.";
// String#strip: null and ASCII whitespace.
const RUBY_STRIP = /^[\0\t-\r ]+|[\0\t-\r ]+$/gu;

type Credential = { id: bigint; nickname: string; created_at: Date; last_used_at: Date | null };

const failure = (message: string): ActionResult =>
  jsonResponse({ success: false, error_message: message }, UNPROCESSABLE, true);

const passkeyProps = (externalId: string, credential: Credential) => ({
  id: externalId,
  nickname: credential.nickname,
  created_at: iso8601(credential.created_at),
  last_used_at: credential.last_used_at ? iso8601(credential.last_used_at) : null,
});

const registrationOptions = (input: MutationInput) =>
  sellerJsonAction(input, settingsPasskeysUserPolicy.registrationOptions, async () => {
    const seller = input.context.currentSeller!;
    const excluded = await db.webauthnCredential.findMany({
      where: { user_id: seller.id },
      orderBy: { id: "asc" },
      select: { webauthn_id: true },
    });
    if (excluded.length >= MAX_PER_USER) return failure(MAX_PER_USER_ERROR_MESSAGE);

    const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");
    input.chain.session.data[REGISTRATION_CHALLENGE_SESSION_KEY] = challenge;
    // WebAuthn::PublicKeyCredential::CreationOptions#as_json: the attributes in the gem's order, a nil dropped.
    const name = seller.email;
    return jsonResponse(
      {
        success: true,
        options: {
          challenge,
          timeout: OPTIONS_TIMEOUT_MS,
          extensions: {},
          rp: { name: "Gumroad", id: rpId() },
          user: {
            ...(name === null ? {} : { name }),
            id: seller.external_id,
            displayName: displayName(seller, { preferEmailOverDefaultUsername: true }) ?? name,
          },
          pubKeyCredParams: COSE_ALGORITHMS.map((alg) => ({ type: PUBLIC_KEY_TYPE, alg })),
          attestation: "none",
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          excludeCredentials: excluded.map(({ webauthn_id }) => ({ type: PUBLIC_KEY_TYPE, id: webauthn_id })),
        },
      },
      200,
      true,
    );
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ActionController::Parameters#permit for a scalar key: a list or hash is dropped.
const scalar = (value: unknown): unknown => (isObject(value) || Array.isArray(value) ? undefined : value);

// #base64url_decoded: a String of the base64url alphabet that Ruby's strict decoder accepts.
function base64urlDecoded(value: unknown): Buffer | null {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) return null;
  return decodeBase64Url(value);
}

type Registration = { id: string; attestation: AttestationObject; clientDataJson: Buffer };

// #credential_params and #valid_credential_params?: null when Rails answers with a VerificationError.
function registrationParams(credential: unknown): Registration | null {
  // params.require(:credential) raises on a blank value, and `respond_to?(:permit)` fails for anything but a hash.
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
  // CBOR.decode of no bytes raises EOFError, which nothing rescues (Rails answers 500), as does a truncated item.
  const attestationBytes = base64urlDecoded(scalar(response.attestationObject));
  if (attestationBytes === null) throw new HandBackToRails("an attestation object that is not base64url");
  const attestation = parseAttestationObject(attestationBytes);
  if (attestation === null) return null;
  const clientDataJson = base64urlDecoded(scalar(response.clientDataJSON));
  if (clientDataJson === null) return null;
  // PublicKeyCredential#valid_id?: the raw id has to be the id.
  if (!base64urlDecoded(rawId)!.equals(base64urlDecoded(id)!)) return null;
  return { id: id as string, attestation, clientDataJson };
}

// String#blank?: nothing but Unicode white space.
const rubyBlank = (value: string) => /^[\p{White_Space}]*$/u.test(value);

type Stored = { credential: Credential } | { refused: "invalid" | "limit" };

// `@user.with_lock { @user.webauthn_credentials.create!(...) }`: the callbacks, then every validation (so a full account reports the
// limit even when the passkey is also a duplicate), then the insert.
function storePasskey(
  userId: bigint,
  passkey: { webauthnId: string; publicKey: string; signCount: number; nickname: string | null },
  now: Date,
): Promise<Stored> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT \`users\`.\`id\` FROM \`users\` WHERE \`users\`.\`id\` = ${userId} LIMIT 1 FOR UPDATE`,
    );
    const sha256 = createHash("sha256").update(passkey.webauthnId).digest("hex");
    const count = await tx.webauthnCredential.count({ where: { user_id: userId } });
    // normalize_nickname, then set_default_nickname
    let nickname = passkey.nickname;
    if (nickname !== null && !rubyBlank(nickname)) nickname = nickname.replace(RUBY_STRIP, "");
    if (nickname === null || rubyBlank(nickname)) nickname = `Passkey ${count + 1}`;

    const taken = (await tx.webauthnCredential.count({ where: { webauthn_id_sha256: sha256 } })) > 0;
    const invalid =
      [...passkey.webauthnId].length > MAX_WEBAUTHN_ID_LENGTH || [...nickname].length > MAX_NICKNAME_LENGTH || taken;
    if (count >= MAX_PER_USER) return { refused: "limit" } as const;
    if (invalid) return { refused: "invalid" } as const;
    const credential = await tx.webauthnCredential.create({
      data: {
        user_id: userId,
        webauthn_id: passkey.webauthnId,
        webauthn_id_sha256: sha256,
        public_key: passkey.publicKey,
        sign_count: BigInt(passkey.signCount),
        nickname,
        created_at: now,
        updated_at: now,
      },
      select: { id: true, nickname: true, created_at: true, last_used_at: true },
    });
    return { credential };
  });
}

const create = (input: MutationInput) =>
  sellerJsonAction(input, settingsPasskeysUserPolicy.create, async () => {
    const { chain } = input;
    const seller = input.context.currentSeller!;
    const challenge = chain.session.data[REGISTRATION_CHALLENGE_SESSION_KEY];
    Reflect.deleteProperty(chain.session.data, REGISTRATION_CHALLENGE_SESSION_KEY);
    if (challenge !== undefined && challenge !== null && typeof challenge !== "string")
      throw new HandBackToRails("a registration challenge that is not text");
    if (challenge === undefined || challenge === null || rubyBlank(challenge))
      return failure(REGISTRATION_ERROR_MESSAGE);

    const requested = input.params.nickname;
    if (requested !== undefined && requested !== null && typeof requested !== "string")
      throw new HandBackToRails("a passkey nickname that is not text");
    // The refresh of the setup prompt reads the signed-in user, who is the seller for the owner this policy lets in.
    if (chain.auth.context.loggedInUser?.id !== seller.id)
      throw new HandBackToRails("a passkey registered for another account than the signed-in one");

    const registration = registrationParams(input.params.credential);
    if (registration === null) return failure(REGISTRATION_ERROR_MESSAGE);
    const verdict = verifyAttestation({
      challenge,
      rpId: rpId(),
      allowedOrigins: allowedOrigins(),
      attestation: registration.attestation,
      clientDataJson: registration.clientDataJson,
    });
    if (!verdict.ok) return failure(REGISTRATION_ERROR_MESSAGE);

    // `params[:nickname].presence || detected_provider_name(webauthn_credential)`
    const nickname =
      requested !== undefined && requested !== null && !rubyBlank(requested)
        ? requested
        : verdict.aaguid === null
          ? null
          : (AAGUID_PROVIDER_NAMES[verdict.aaguid] ?? null);
    const user = await findUser(seller.id);
    if (user === null) throw new HandBackToRails("a seller who is gone");

    const stored = await storePasskey(
      seller.id,
      { webauthnId: registration.id, publicKey: verdict.publicKey, signCount: verdict.signCount, nickname },
      chain.now,
    );
    if ("refused" in stored)
      return failure(stored.refused === "limit" ? MAX_PER_USER_ERROR_MESSAGE : REGISTRATION_ERROR_MESSAGE);
    await refreshPasskeySetupPrompt(chain, user);
    return jsonResponse(
      { success: true, passkey: passkeyProps(encrypt(Number(stored.credential.id)), stored.credential) },
      CREATED,
      true,
    );
  });

// `set_webauthn_credential`: `@user.webauthn_credentials.find_by_external_id(params[:id]) || e404`, after `authorize`.
function credentialAction(
  input: MutationInput,
  policy: (context: SellerContext) => boolean,
  run: (credential: Credential) => Promise<ActionResult>,
): Promise<ActionResult> {
  return sellerJsonAction(input, policy, async () => {
    const id = decrypt(input.routeParams.id!);
    const credential =
      id === null
        ? null
        : await db.webauthnCredential.findFirst({
            where: { id: BigInt(id), user_id: input.context.currentSeller!.id },
            select: { id: true, nickname: true, created_at: true, last_used_at: true },
          });
    if (credential === null) throw new RoutingError("Not Found");
    return run(credential);
  });
}

const update = (input: MutationInput) =>
  credentialAction(input, settingsPasskeysUserPolicy.update, async (credential) => {
    const requested = input.params.nickname;
    if (requested !== undefined && requested !== null && typeof requested !== "string")
      throw new HandBackToRails("a passkey nickname that is not text");
    const nickname = (requested ?? "").replace(RUBY_STRIP, "");
    if (nickname === "" || [...nickname].length > MAX_NICKNAME_LENGTH) return failure(UPDATE_ERROR_MESSAGE);

    // An unchanged name is no write: `updated_at` stays.
    if (nickname !== credential.nickname)
      await db.webauthnCredential.update({ where: { id: credential.id }, data: { nickname, updated_at: new Date() } });
    return jsonResponse(
      { success: true, passkey: passkeyProps(input.routeParams.id!, { ...credential, nickname }) },
      200,
      true,
    );
  });

const destroy = (input: MutationInput) =>
  credentialAction(input, settingsPasskeysUserPolicy.destroy, async (credential) => {
    await db.webauthnCredential.delete({ where: { id: credential.id } });
    return jsonResponse({ success: true }, 200, true);
  });

const ID = ":id([A-Za-z0-9_=-]+)";

registerMutations(
  { method: "POST", pattern: "/settings/passkeys/registration_options", formats: ["json"], run: registrationOptions },
  { method: "POST", pattern: "/settings/passkeys", formats: ["json"], run: create },
  { method: "PUT", pattern: `/settings/passkeys/${ID}`, formats: ["json"], run: update },
  { method: "PATCH", pattern: `/settings/passkeys/${ID}`, formats: ["json"], run: update },
  { method: "DELETE", pattern: `/settings/passkeys/${ID}`, formats: ["json"], run: destroy },
);
