// WebAuthn::PublicKeyCredentialWithAttestation#verify (webauthn-ruby 3.4.3) for a passkey registration, where the relying party asks for
// no attestation: the client data, the authenticator data of an ES256 credential, and the `none` statement. The attestation formats
// that carry a signature or a certificate chain, and every other key type, are not judged here; they throw HandBackToRails, as does
// anything the gem would raise on instead of decide (see webauthn-assertion.ts).
import { timingSafeEqual } from "node:crypto";

import { HandBackToRails } from "../controllers/application-controller.ts";

import {
  AUTHENTICATOR_DATA_LENGTH,
  type AttestedCredential,
  decodeBase64Url,
  FLAG_ATTESTED_CREDENTIAL_DATA,
  FLAG_USER_PRESENT,
  FLAG_USER_VERIFIED,
  FLAGS_OFFSET,
  parseAuthenticatorData,
  parseClientData,
  readCbor,
  RP_ID_HASH_LENGTH,
  sha256,
  SIGN_COUNT_OFFSET,
  validTokenBinding,
} from "./webauthn-assertion.ts";

const CLIENT_DATA_TYPE = "webauthn.create";
const FORMAT_NONE = "none";
// WebAuthn::AttestationStatement::FORMAT_TO_CLASS minus `none`.
const SIGNED_FORMATS = new Set(["fido-u2f", "packed", "android-safetynet", "android-key", "tpm", "apple"]);
const AAGUID_GROUPS = [8, 4, 4, 4, 12];

export type AttestationRefusal = { ok: false };
export type AttestationAccepted = {
  ok: true;
  // The COSE key as the controller stores it: base64url without padding.
  publicKey: string;
  signCount: number;
  // AuthenticatorData#aaguid: nil for a zeroed one.
  aaguid: string | null;
};

export type AttestationInput = {
  // The challenge as stored in the session (base64url).
  challenge: string;
  rpId: string;
  allowedOrigins: string[];
  attestation: AttestationObject;
  clientDataJson: Buffer;
};

export type AttestationObject = { format: string; statement: Map<unknown, unknown>; authenticatorData: Buffer };

// #valid_attestation_object? of the controller: one CBOR map holding `fmt` (text), `attStmt` (a map) and `authData` (bytes).
// Null when Rails answers with a VerificationError. readCbor reads a subset of CBOR and can run off the end of a truncated item with a
// RangeError, which here is a shape to leave to Rails.
export function parseAttestationObject(bytes: Buffer): AttestationObject | null {
  let item;
  let end;
  try {
    [item, end] = readCbor(bytes, 0);
  } catch (error) {
    if (error instanceof HandBackToRails) throw error;
    throw new HandBackToRails("an attestation object Node cannot read");
  }
  // CBOR.decode raises MalformedFormatError for bytes after the item.
  if (end !== bytes.length || !(item instanceof Map)) return null;
  const format = item.get("fmt");
  const statement = item.get("attStmt");
  const authenticatorData = item.get("authData");
  if (typeof format !== "string" || !(statement instanceof Map)) return null;
  if (typeof authenticatorData === "string") throw new HandBackToRails("authenticator data sent as CBOR text");
  if (!Buffer.isBuffer(authenticatorData)) return null;
  return { format, statement, authenticatorData };
}

// AuthenticatorData#aaguid, in the 8-4-4-4-12 form the provider table keys.
export function formatAaguid(aaguid: Buffer): string | null {
  if (aaguid.every((byte) => byte === 0)) return null;
  const hex = aaguid.toString("hex");
  let offset = 0;
  return AAGUID_GROUPS.map((length) => {
    const group = hex.slice(offset, offset + length);
    offset += length;
    return group;
  }).join("-");
}

// `credential.verify(challenge, user_verification: true)` for a credential built by `WebAuthn::Credential.from_create`: every failure
// Rails maps to a VerificationError is `{ ok: false }`.
export function verifyAttestation(input: AttestationInput): AttestationAccepted | AttestationRefusal {
  const refused: AttestationRefusal = { ok: false };
  const expectedChallenge = decodeBase64Url(input.challenge);
  if (expectedChallenge === null) return refused;

  const { attestation } = input;
  const clientData = parseClientData(input.clientDataJson);
  // #valid_client_data_json? of the controller.
  if (
    typeof clientData.type !== "string" ||
    typeof clientData.challenge !== "string" ||
    typeof clientData.origin !== "string"
  )
    return refused;

  if (clientData.type !== CLIENT_DATA_TYPE) return refused;
  if (!validTokenBinding(clientData.tokenBinding)) return refused;
  const clientChallenge = decodeBase64Url(clientData.challenge);
  if (clientChallenge === null) return refused;
  if (clientChallenge.length !== expectedChallenge.length || !timingSafeEqual(clientChallenge, expectedChallenge))
    return refused;
  if (!input.allowedOrigins.includes(clientData.origin)) return refused;

  // The attestation object is read here: authenticator data first, then the statement for the format it names.
  const authenticatorData = attestation.authenticatorData;
  if (authenticatorData.length < AUTHENTICATOR_DATA_LENGTH) return refused;
  if (attestation.format !== FORMAT_NONE && !SIGNED_FORMATS.has(attestation.format)) return refused;
  const flags = authenticatorData[FLAGS_OFFSET]!;
  const parsed = parseAuthenticatorData(authenticatorData, flags);
  if (!parsed.valid) return refused;
  if (!authenticatorData.subarray(0, RP_ID_HASH_LENGTH).equals(sha256(input.rpId))) return refused;
  // user_presence is not given and the relying party is not silent, so a present or a verified user passes; the controller demands
  // verification on top.
  if ((flags & (FLAG_USER_PRESENT | FLAG_USER_VERIFIED)) === 0) return refused;
  if ((flags & FLAG_USER_VERIFIED) === 0) return refused;

  // #valid_attested_credential?: the flag, and an algorithm the relying party offers (ES256 is the one read here).
  if ((flags & FLAG_ATTESTED_CREDENTIAL_DATA) === 0 || parsed.credential === null) return refused;
  if (attestation.format !== FORMAT_NONE) throw new HandBackToRails("an attestation statement Node does not verify");
  // AttestationStatement::None#valid?: an empty statement.
  if (attestation.statement.size !== 0) return refused;

  const credential: AttestedCredential = parsed.credential;
  return {
    ok: true,
    publicKey: credential.key.toString("base64url"),
    signCount: authenticatorData.readUInt32BE(SIGN_COUNT_OFFSET),
    aaguid: formatAaguid(credential.aaguid),
  };
}
