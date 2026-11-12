import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../controllers/application-controller.ts";

import { formatAaguid, parseAttestationObject, verifyAttestation } from "./webauthn-attestation.ts";

const RP_ID = "test.gumroad.com";
const ORIGIN = "http://app.test.gumroad.com:31337";
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();

const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
// A COSE_Key for ES256: {1: 2, 3: -7, -1: 1, -2: x, -3: y}.
const coseKey = Buffer.concat([
  Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
  Buffer.from(jwk.x!, "base64url"),
  Buffer.from([0x22, 0x58, 0x20]),
  Buffer.from(jwk.y!, "base64url"),
]);

const challenge = Buffer.alloc(32, 9).toString("base64url");
const AAGUID = Buffer.from("fbfc3007154e4ecc8c0b6e020557d7bd", "hex");
const CREDENTIAL_ID = Buffer.alloc(16, 3);

const text = (value: string) => Buffer.concat([Buffer.from([0x60 + value.length]), Buffer.from(value)]);
const bytes = (value: Buffer) =>
  Buffer.concat([
    value.length < 24
      ? Buffer.from([0x40 + value.length])
      : Buffer.from([0x59, value.length >> 8, value.length & 0xff]),
    value,
  ]);

function authenticatorData({
  flags = 0x45,
  rpId = RP_ID,
  tail = Buffer.concat([AAGUID, Buffer.from([0, 16]), CREDENTIAL_ID, coseKey]),
} = {}) {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(5);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, tail]);
}

function attestationObject(data: Buffer, { format = "none", statement = Buffer.from([0xa0]) } = {}) {
  return Buffer.concat([
    Buffer.from([0xa3]),
    text("fmt"),
    text(format),
    text("attStmt"),
    statement,
    text("authData"),
    bytes(data),
  ]);
}

function input(overrides: { data?: Buffer; object?: Buffer; client?: object } = {}) {
  const object = overrides.object ?? attestationObject(overrides.data ?? authenticatorData());
  const attestation = parseAttestationObject(object);
  if (attestation === null) throw new Error("fixture is no attestation object");
  return {
    challenge,
    rpId: RP_ID,
    allowedOrigins: [ORIGIN],
    attestation,
    clientDataJson: Buffer.from(
      JSON.stringify(overrides.client ?? { type: "webauthn.create", challenge, origin: ORIGIN }),
    ),
  };
}

describe("verifyAttestation", () => {
  it("accepts a verified attestation with the none format and reports the key, counter and authenticator", () => {
    expect(verifyAttestation(input())).toEqual({
      ok: true,
      publicKey: coseKey.toString("base64url"),
      signCount: 5,
      aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
    });
  });

  it("reports no authenticator for a zeroed AAGUID", () => {
    const tail = Buffer.concat([Buffer.alloc(16), Buffer.from([0, 16]), CREDENTIAL_ID, coseKey]);
    expect(verifyAttestation(input({ data: authenticatorData({ tail }) }))).toMatchObject({ ok: true, aaguid: null });
  });

  it.each([
    ["client data of another type", { client: { type: "webauthn.get", challenge, origin: ORIGIN } }],
    [
      "another challenge",
      { client: { type: "webauthn.create", challenge: Buffer.alloc(32, 1).toString("base64url"), origin: ORIGIN } },
    ],
    ["another origin", { client: { type: "webauthn.create", challenge, origin: "https://example.com" } }],
    ["client data without an origin", { client: { type: "webauthn.create", challenge } }],
    ["another relying party", { data: authenticatorData({ rpId: "example.com" }) }],
    ["an unverified user", { data: authenticatorData({ flags: 0x41 }) }],
    ["no flagged user", { data: authenticatorData({ flags: 0x40 }) }],
    ["no attested credential data", { data: authenticatorData({ flags: 0x05, tail: Buffer.alloc(0) }) }],
    [
      "a statement that is not empty",
      { object: attestationObject(authenticatorData(), { statement: Buffer.from([0xa1, 0x60, 0x00]) }) },
    ],
    ["a format the gem does not know", { object: attestationObject(authenticatorData(), { format: "bogus" }) }],
    ["authenticator data shorter than the fixed part", { data: Buffer.alloc(36) }],
  ])("refuses %s", (_name, overrides) => {
    expect(verifyAttestation(input(overrides))).toEqual({ ok: false });
  });

  it.each(["packed", "tpm", "fido-u2f", "apple", "android-key", "android-safetynet"])(
    "leaves the %s format to Rails once everything it does not sign checks out",
    (format) => {
      expect(() => verifyAttestation(input({ object: attestationObject(authenticatorData(), { format }) }))).toThrow(
        HandBackToRails,
      );
    },
  );

  it("leaves a key that is not ES256 to Rails", () => {
    const rsa = Buffer.from([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20, 0x41, 0x01, 0x21, 0x41, 0x01]);
    const tail = Buffer.concat([AAGUID, Buffer.from([0, 16]), CREDENTIAL_ID, rsa]);
    expect(() => verifyAttestation(input({ data: authenticatorData({ tail }) }))).toThrow(HandBackToRails);
  });
});

describe("parseAttestationObject", () => {
  it("is null for bytes after the map, text, and a map without its parts", () => {
    expect(
      parseAttestationObject(Buffer.concat([attestationObject(authenticatorData()), Buffer.from([0])])),
    ).toBeNull();
    expect(parseAttestationObject(text("none"))).toBeNull();
    expect(parseAttestationObject(Buffer.concat([Buffer.from([0xa1]), text("fmt"), text("none")]))).toBeNull();
  });

  it("hands a truncated item back instead of deciding, as the gem raises EOFError", () => {
    expect(() => parseAttestationObject(attestationObject(authenticatorData()).subarray(0, 20))).toThrow(
      HandBackToRails,
    );
  });
});

describe("formatAaguid", () => {
  it("formats 8-4-4-4-12 and drops a zeroed one", () => {
    expect(formatAaguid(AAGUID)).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd");
    expect(formatAaguid(Buffer.alloc(16))).toBeNull();
  });
});
