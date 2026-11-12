// WebAuthn::PublicKeyCredentialWithAssertion#verify (webauthn-ruby 3.4.3) for the passkey login: the client data, the authenticator
// data, the ES256, RS256 or PS256 signature and the counter. Anything this does not decide exactly as the gem does throws HandBackToRails, so Rails
// answers instead: another algorithm, client data that is not a JSON object, a signature OpenSSL would raise on rather than reject (Rails
// answers 500 for those, which no recording can compare), and attested credential or extension data the gem would raise on (see
// authenticatorDataValid).
import { constants, createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

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
const COSE_KTY_RSA = 3;
const COSE_ALG_RS256 = -257;
const COSE_ALG_PS256 = -37;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;
const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
const DER_LONG_FORM = 0x80;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_GROUP = 4;
const AAGUID_LENGTH = 16;
const CREDENTIAL_ID_LENGTH_LENGTH = 2;
const CBOR_FALSE = 0xf4;
const CBOR_TRUE = 0xf5;
const CBOR_NULL = 0xf6;

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

type StoredKey = { kind: "ec"; x: Buffer; y: Buffer } | { kind: "rsa"; n: Buffer; e: Buffer; pss: boolean };

// WebAuthn::PublicKey.deserialize: an uncompressed P-256 point (the format before webauthn-ruby 1.12) or a COSE_Key, which is read
// for the algorithm it names (ES256, RS256 or PS256 with the key type each needs).
function storedKey(publicKey: Buffer): StoredKey {
  if (publicKey.length === UNCOMPRESSED_POINT_LENGTH && publicKey[0] === UNCOMPRESSED_POINT_PREFIX)
    return {
      kind: "ec",
      x: publicKey.subarray(1, 1 + COORDINATE_LENGTH),
      y: publicKey.subarray(1 + COORDINATE_LENGTH),
    };
  const [key, end] = readCbor(publicKey, 0);
  if (!(key instanceof Map) || end !== publicKey.length)
    throw new HandBackToRails("a stored key that is not a COSE map");
  const algorithm = key.get(3);
  if (key.get(1) === COSE_KTY_RSA && (algorithm === COSE_ALG_RS256 || algorithm === COSE_ALG_PS256)) {
    const n = key.get(-1);
    const e = key.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length === 0 || e.length === 0)
      throw new HandBackToRails("a stored RSA passkey with no modulus or exponent");
    return { kind: "rsa", n, e, pss: algorithm === COSE_ALG_PS256 };
  }
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
    throw new HandBackToRails("a stored passkey that is not ES256, RS256 or PS256");
  return { kind: "ec", x, y };
}

// RS256 is OpenSSL's PKCS#1 v1.5 verify; PS256 is verify_pss with `salt_length: :auto` and SHA-256 for the mask. Both answer false for a
// signature that does not verify, whatever its length.
function rsaSignatureValid(key: Extract<StoredKey, { kind: "rsa" }>, signed: Buffer, signature: Buffer): boolean {
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: { kty: "RSA", n: key.n.toString("base64url"), e: key.e.toString("base64url") },
      format: "jwk",
    });
  } catch {
    throw new HandBackToRails("an RSA key Node cannot load");
  }
  return verify(
    "sha256",
    signed,
    key.pss
      ? { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_AUTO }
      : { key: publicKey },
    signature,
  );
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

// CBOR.encode for the items readCbor reads, with the shortest length heads; compared with the bytes read, it proves the gem's
// `CBOR.encode(first_item).length` is the length on the wire.
function encodeCbor(value: CborValue): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Map)
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [encodeCbor(k), encodeCbor(v)])]);
  throw new HandBackToRails("a CBOR value Node does not write");
}

// The first CBOR item of `bytes` and where it ends, or a hand-back when the gem could raise instead of decide: a truncated item
// (EOFError, which nothing rescues), a type outside readCbor's subset, or an encoding that is not the shortest one.
function firstCborItem(bytes: Buffer): [CborValue, number] {
  const [value, end] = readCbor(bytes, 0);
  if (!encodeCbor(value).equals(bytes.subarray(0, end)))
    throw new HandBackToRails("CBOR that is not in its shortest form");
  return [value, end];
}

// WebAuthn::AuthenticatorData#valid? for the bytes after the 37 fixed ones: attested credential data (AAGUID, id, an ES256 COSE key) and
// then extension data (one CBOR item that is not null or false, with nothing after it) when the flags say so, and no bytes left over.
// A shape where the gem raises something Rails does not rescue, or one whose COSE key it would have to judge, is a hand-back.
function authenticatorDataValid(authenticatorData: Buffer, flags: number): boolean {
  const tail = authenticatorData.subarray(AUTHENTICATOR_DATA_LENGTH);
  const attested = (flags & FLAG_ATTESTED_CREDENTIAL_DATA) !== 0;
  const extensions = (flags & FLAG_EXTENSION_DATA) !== 0;
  let position = 0;
  if (attested) {
    if (tail.length < AAGUID_LENGTH + CREDENTIAL_ID_LENGTH_LENGTH)
      throw new HandBackToRails("truncated attested credential data");
    position = AAGUID_LENGTH + CREDENTIAL_ID_LENGTH_LENGTH + tail.readUInt16BE(AAGUID_LENGTH);
    if (tail.length < position) throw new HandBackToRails("truncated attested credential data");
    const [key, keyLength] = firstCborItem(tail.subarray(position));
    const x = key instanceof Map ? key.get(-2) : undefined;
    const y = key instanceof Map ? key.get(-3) : undefined;
    if (
      !(key instanceof Map) ||
      key.size !== 5 ||
      key.get(1) !== COSE_KTY_EC2 ||
      key.get(3) !== COSE_ALG_ES256 ||
      key.get(-1) !== COSE_CRV_P256 ||
      !Buffer.isBuffer(x) ||
      !Buffer.isBuffer(y) ||
      x.length !== COORDINATE_LENGTH ||
      y.length !== COORDINATE_LENGTH
    )
      throw new HandBackToRails("an attested credential key Node does not judge");
    position += keyLength;
  }
  if (!extensions) return position === tail.length;
  // CBOR.decode of nothing raises EOFError; of an item followed by more bytes raises MalformedFormatError, which Rails maps to a refusal.
  const raw = tail.subarray(position);
  if (raw.length === 0) throw new HandBackToRails("empty extension data");
  if (raw.length === 1 && (raw[0] === CBOR_NULL || raw[0] === CBOR_FALSE)) return false;
  if (raw.length === 1 && raw[0] === CBOR_TRUE) return true;
  const [, end] = firstCborItem(raw);
  return end === raw.length;
}

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
  if (!authenticatorDataValid(authenticatorData, flags)) return refused;
  const rpIdHash = authenticatorData.subarray(0, RP_ID_HASH_LENGTH);
  if (!rpIdHash.equals(sha256(input.rpId))) return refused;
  // Neither user_presence nor silent_authentication is set: a present or verified user passes; the login demands verification.
  if ((flags & (FLAG_USER_PRESENT | FLAG_USER_VERIFIED)) === 0) return refused;
  if ((flags & FLAG_USER_VERIFIED) === 0) return refused;

  const stored = storedKey(publicKey);
  const signed = Buffer.concat([authenticatorData, sha256(input.clientDataJson)]);
  if (stored.kind === "rsa") {
    if (!rsaSignatureValid(stored, signed, input.signature)) return refused;
  } else {
    if (!wellFormedDerSignature(input.signature)) throw new HandBackToRails("a signature OpenSSL cannot parse");
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: stored.x.toString("base64url"), y: stored.y.toString("base64url") },
      format: "jwk",
    });
    if (!verify("sha256", signed, { key, dsaEncoding: "der" }, input.signature)) return refused;
  }

  // #valid_sign_count?: a counter that never moved is fine, otherwise it has to grow.
  const signCount = authenticatorData.readUInt32BE(SIGN_COUNT_OFFSET);
  if ((signCount !== 0 || input.storedSignCount !== 0) && signCount <= input.storedSignCount) return refused;
  return { ok: true, signCount };
}
