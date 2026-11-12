// WebAuthn::PublicKeyCredentialWithAssertion#verify (webauthn-ruby 3.4.3) for the passkey login: the client data, the authenticator
// data, the ES256 signature and the counter. Anything this does not decide exactly as the gem does throws HandBackToRails, so Rails
// answers instead: an algorithm other than ES256, authenticator data with attested credential or extension data, client data that is
// not a JSON object, and a signature OpenSSL would raise on rather than reject.
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

import { HandBackToRails } from "../controllers/application-controller.ts";

const CLIENT_DATA_TYPE = "webauthn.get";
const TOKEN_BINDING_STATUSES = ["present", "supported", "not-supported"];
const RP_ID_HASH_LENGTH = 32;
const AUTHENTICATOR_DATA_LENGTH = 37;
const FLAGS_OFFSET = 32;
const SIGN_COUNT_OFFSET = 33;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
const FLAG_EXTENSION_DATA = 0x80;
const UNCOMPRESSED_POINT_LENGTH = 65;
const UNCOMPRESSED_POINT_PREFIX = 0x04;
const COORDINATE_LENGTH = 32;
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;
const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
const DER_LONG_FORM = 0x80;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_GROUP = 4;

export type AssertionRefusal = { ok: false };
export type AssertionAccepted = { ok: true; signCount: number };

// WebAuthn::Encoders::Base64UrlEncoder.decode: padding is added when missing, `-_` become `+/`, and `unpack1("m0")` is strict (no
// stray characters, exact padding, no non-zero trailing bits). Null when Ruby raises ArgumentError.
export function decodeBase64Url(data: string): Buffer | null {
  let padded = data;
  if (!data.endsWith("=") && data.length % BASE64_GROUP !== 0) padded = data.padEnd((data.length + 3) & ~3, "=");
  const standard = padded.replaceAll("-", "+").replaceAll("_", "/");
  if (!STANDARD_BASE64.test(standard) || standard.length % BASE64_GROUP !== 0) return null;
  const bytes = Buffer.from(standard, "base64");
  return bytes.toString("base64") === standard ? bytes : null;
}

// ---- COSE public key

type CborValue = number | bigint | Buffer | string | Map<CborValue, CborValue> | CborValue[] | boolean | null;

// The subset of CBOR a COSE key uses. Anything else is not read: the key is handed back to Rails.
function readCbor(bytes: Buffer, offset: number): [CborValue, number] {
  const initial = bytes[offset];
  if (initial === undefined) throw new HandBackToRails("a truncated COSE key");
  const major = initial >> 5;
  const info = initial & 0x1f;
  let cursor = offset + 1;
  let length: number;
  if (info < 24) length = info;
  else if (info === 24) length = bytes.readUInt8(cursor++);
  else if (info === 25) {
    length = bytes.readUInt16BE(cursor);
    cursor += 2;
  } else throw new HandBackToRails("a COSE key with a wide CBOR length");
  switch (major) {
    case 0:
      return [length, cursor];
    case 1:
      return [-1 - length, cursor];
    case 2:
    case 3: {
      const slice = bytes.subarray(cursor, cursor + length);
      if (slice.length !== length) throw new HandBackToRails("a truncated COSE key");
      return [major === 2 ? Buffer.from(slice) : slice.toString("utf8"), cursor + length];
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      let position = cursor;
      for (let i = 0; i < length; i += 1) {
        const [key, afterKey] = readCbor(bytes, position);
        const [value, afterValue] = readCbor(bytes, afterKey);
        map.set(key, value);
        position = afterValue;
      }
      return [map, position];
    }
    default:
      throw new HandBackToRails("a COSE key with a CBOR type it does not use");
  }
}

// WebAuthn::PublicKey.deserialize: an uncompressed P-256 point (the format before webauthn-ruby 1.12) or a COSE_Key.
function es256Coordinates(publicKey: Buffer): { x: Buffer; y: Buffer } {
  if (publicKey.length === UNCOMPRESSED_POINT_LENGTH && publicKey[0] === UNCOMPRESSED_POINT_PREFIX)
    return { x: publicKey.subarray(1, 1 + COORDINATE_LENGTH), y: publicKey.subarray(1 + COORDINATE_LENGTH) };
  const [key, end] = readCbor(publicKey, 0);
  if (!(key instanceof Map) || end !== publicKey.length)
    throw new HandBackToRails("a stored key that is not a COSE map");
  const x = key.get(-2);
  const y = key.get(-3);
  if (
    key.get(1) !== COSE_KTY_EC2 ||
    key.get(3) !== COSE_ALG_ES256 ||
    key.get(-1) !== COSE_CRV_P256 ||
    !Buffer.isBuffer(x) ||
    !Buffer.isBuffer(y) ||
    x.length !== COORDINATE_LENGTH ||
    y.length !== COORDINATE_LENGTH
  )
    throw new HandBackToRails("a stored passkey that is not ES256");
  return { x, y };
}

// OpenSSL parses the signature as a canonical DER ECDSA-Sig-Value and raises on anything else; only a well-formed one is judged here.
function readDerLength(bytes: Buffer, offset: number): [number, number] | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  if (first < DER_LONG_FORM) return [first, offset + 1];
  const count = first & 0x7f;
  if (count === 0 || count > 2 || offset + 1 + count > bytes.length) return null;
  let length = 0;
  for (let i = 0; i < count; i += 1) length = (length << 8) | bytes[offset + 1 + i]!;
  // Minimal length encoding only.
  if (length < DER_LONG_FORM || (count === 2 && length < 0x100)) return null;
  return [length, offset + 1 + count];
}

function readDerInteger(bytes: Buffer, offset: number): number | null {
  if (bytes[offset] !== DER_INTEGER) return null;
  const parsed = readDerLength(bytes, offset + 1);
  if (parsed === null) return null;
  const [length, start] = parsed;
  if (length === 0 || start + length > bytes.length) return null;
  const first = bytes[start]!;
  if ((first & 0x80) !== 0) return null;
  if (length > 1 && first === 0 && (bytes[start + 1]! & 0x80) === 0) return null;
  return start + length;
}

function wellFormedDerSignature(signature: Buffer): boolean {
  if (signature[0] !== DER_SEQUENCE) return false;
  const parsed = readDerLength(signature, 1);
  if (parsed === null) return false;
  const [length, start] = parsed;
  if (start + length !== signature.length) return false;
  const afterR = readDerInteger(signature, start);
  if (afterR === null) return false;
  return readDerInteger(signature, afterR) === signature.length;
}

// ---- client data and authenticator data

type ClientData = { type: unknown; challenge: unknown; origin: unknown; tokenBinding: unknown };

function parseClientData(clientDataJson: Buffer): ClientData {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clientDataJson));
  } catch {
    throw new HandBackToRails("client data that is not JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new HandBackToRails("client data that is not a JSON object");
  const object = data as Record<string, unknown>;
  return { type: object.type, challenge: object.challenge, origin: object.origin, tokenBinding: object.tokenBinding };
}

// ClientData#valid_token_binding_format?: a falsy token binding is fine, any other must be a hash with a known status.
function validTokenBinding(tokenBinding: unknown): boolean {
  if (tokenBinding === undefined || tokenBinding === null || tokenBinding === false) return true;
  if (typeof tokenBinding !== "object" || Array.isArray(tokenBinding)) return false;
  return TOKEN_BINDING_STATUSES.includes((tokenBinding as Record<string, unknown>).status as string);
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();

export type AssertionInput = {
  // The challenge as stored in the session (base64url).
  challenge: string;
  // The stored COSE key, base64url.
  publicKey: string;
  storedSignCount: number;
  rpId: string;
  allowedOrigins: string[];
  authenticatorData: Buffer;
  clientDataJson: Buffer;
  signature: Buffer;
};

// `webauthn_credential.verify(challenge, public_key:, sign_count:, user_verification: true)`: every failure Rails maps to a
// VerificationError is `{ ok: false }`.
export function verifyAssertion(input: AssertionInput): AssertionAccepted | AssertionRefusal {
  const refused: AssertionRefusal = { ok: false };
  const expectedChallenge = decodeBase64Url(input.challenge);
  const publicKey = decodeBase64Url(input.publicKey);
  if (expectedChallenge === null || publicKey === null) return refused;

  const clientData = parseClientData(input.clientDataJson);
  if (clientData.type !== CLIENT_DATA_TYPE) return refused;
  if (!validTokenBinding(clientData.tokenBinding)) return refused;
  if (typeof clientData.challenge !== "string") throw new HandBackToRails("client data whose challenge is not text");
  const clientChallenge = decodeBase64Url(clientData.challenge);
  if (clientChallenge === null) return refused;
  if (clientChallenge.length !== expectedChallenge.length || !timingSafeEqual(clientChallenge, expectedChallenge))
    return refused;
  if (typeof clientData.origin !== "string" || !input.allowedOrigins.includes(clientData.origin)) return refused;

  // AuthenticatorData: 32 bytes of rp id hash, a flags byte and a big-endian counter; attested credential data and extensions
  // follow only when their flags say so.
  const authenticatorData = input.authenticatorData;
  if (authenticatorData.length < AUTHENTICATOR_DATA_LENGTH) return refused;
  const flags = authenticatorData[FLAGS_OFFSET]!;
  if ((flags & (FLAG_ATTESTED_CREDENTIAL_DATA | FLAG_EXTENSION_DATA)) !== 0)
    throw new HandBackToRails("authenticator data with attested credential or extension data");
  if (authenticatorData.length !== AUTHENTICATOR_DATA_LENGTH) return refused;
  const rpIdHash = authenticatorData.subarray(0, RP_ID_HASH_LENGTH);
  if (!rpIdHash.equals(sha256(input.rpId))) return refused;
  // Neither user_presence nor silent_authentication is set: a present or verified user passes; the login demands verification.
  if ((flags & (FLAG_USER_PRESENT | FLAG_USER_VERIFIED)) === 0) return refused;
  if ((flags & FLAG_USER_VERIFIED) === 0) return refused;

  const { x, y } = es256Coordinates(publicKey);
  if (!wellFormedDerSignature(input.signature)) throw new HandBackToRails("a signature OpenSSL cannot parse");
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") },
    format: "jwk",
  });
  const signed = Buffer.concat([authenticatorData, sha256(input.clientDataJson)]);
  if (!verify("sha256", signed, { key, dsaEncoding: "der" }, input.signature)) return refused;

  // #valid_sign_count?: a counter that never moved is fine, otherwise it has to grow.
  const signCount = authenticatorData.readUInt32BE(SIGN_COUNT_OFFSET);
  if ((signCount !== 0 || input.storedSignCount !== 0) && signCount <= input.storedSignCount) return refused;
  return { ok: true, signCount };
}
