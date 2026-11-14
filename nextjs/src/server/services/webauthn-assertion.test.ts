import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decodeBase64Url, verifyAssertion, type AssertionInput } from "./webauthn-assertion.ts";

const RP_ID = "test.gumroad.com";
const ORIGIN = "http://app.test.gumroad.com:31337";
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const x = Buffer.from(jwk.x!, "base64url");
const y = Buffer.from(jwk.y!, "base64url");

// A COSE_Key for ES256: {1: 2, 3: -7, -1: 1, -2: x, -3: y}.
const coseKey = Buffer.concat([
  Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
  x,
  Buffer.from([0x22, 0x58, 0x20]),
  y,
]);

const challengeBytes = Buffer.alloc(32, 7);
const challenge = challengeBytes.toString("base64url");

function authenticatorData(flags: number, signCount: number, rpId = RP_ID) {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter]);
}

function assertion(overrides: Partial<AssertionInput> & { flags?: number; signCount?: number; client?: object } = {}) {
  const data = overrides.authenticatorData ?? authenticatorData(overrides.flags ?? 0x05, overrides.signCount ?? 1);
  const clientDataJson = Buffer.from(
    JSON.stringify(overrides.client ?? { type: "webauthn.get", challenge, origin: ORIGIN }),
  );
  const signature = sign("sha256", Buffer.concat([data, sha256(clientDataJson)]), {
    key: privateKey,
    dsaEncoding: "der",
  });
  return {
    challenge,
    publicKey: coseKey.toString("base64url"),
    storedSignCount: 0,
    rpId: RP_ID,
    allowedOrigins: [ORIGIN],
    authenticatorData: data,
    clientDataJson,
    signature,
    ...overrides,
  } as AssertionInput;
}

describe("verifyAssertion", () => {
  it("accepts a verified assertion and reports its counter", () => {
    expect(verifyAssertion(assertion())).toEqual({ ok: true, signCount: 1 });
  });

  it("accepts the uncompressed point format of the early gem versions", () => {
    const point = Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");
    expect(verifyAssertion(assertion({ publicKey: point })).ok).toBe(true);
  });

  it.each([
    ["a signature over other data", () => ({ ...assertion(), signature: assertion({ signCount: 2 }).signature })],
    [
      "another challenge",
      () =>
        assertion({ client: { type: "webauthn.get", challenge: sha256("x").toString("base64url"), origin: ORIGIN } }),
    ],
    [
      "a type other than webauthn.get",
      () => assertion({ client: { type: "webauthn.create", challenge, origin: ORIGIN } }),
    ],
    [
      "another origin",
      () => assertion({ client: { type: "webauthn.get", challenge, origin: "https://evil.example.com" } }),
    ],
    [
      "a token binding that is not a hash",
      () => assertion({ client: { type: "webauthn.get", challenge, origin: ORIGIN, tokenBinding: "x" } }),
    ],
    ["another relying party", () => assertion({ authenticatorData: authenticatorData(0x05, 1, "evil.example.com") })],
    ["a user who was only present", () => assertion({ flags: 0x01 })],
    ["no user at all", () => assertion({ flags: 0x00 })],
    [
      "trailing bytes after the counter",
      () => assertion({ authenticatorData: Buffer.concat([authenticatorData(0x05, 1), Buffer.from([0])]) }),
    ],
    ["authenticator data that is too short", () => assertion({ authenticatorData: Buffer.alloc(10) })],
    ["a counter that did not grow", () => ({ ...assertion({ signCount: 5 }), storedSignCount: 5 })],
    ["a counter that went back", () => ({ ...assertion({ signCount: 2 }), storedSignCount: 5 })],
    ["a challenge that is not base64", () => ({ ...assertion(), challenge: "!!!" })],
  ])("refuses %s", (_name, build) => {
    expect(verifyAssertion(build())).toEqual({ ok: false });
  });

  it("accepts a counter of zero from a credential that never counted, and one that grows", () => {
    expect(verifyAssertion(assertion({ signCount: 0 })).ok).toBe(true);
    expect(verifyAssertion({ ...assertion({ signCount: 6 }), storedSignCount: 5 }).ok).toBe(true);
  });

  it("accepts a falsy token binding and a hash with a known status", () => {
    const base = { type: "webauthn.get", challenge, origin: ORIGIN };
    expect(verifyAssertion(assertion({ client: { ...base, tokenBinding: null } })).ok).toBe(true);
    expect(verifyAssertion(assertion({ client: { ...base, tokenBinding: { status: "supported" } } })).ok).toBe(true);
    expect(verifyAssertion(assertion({ client: { ...base, tokenBinding: { status: "other" } } })).ok).toBe(false);
  });

  it.each([
    ["client data that is not JSON", () => assertion({ clientDataJson: Buffer.from("not json") })],
    ["client data that is not an object", () => assertion({ clientDataJson: Buffer.from("[1]") })],
    [
      "a challenge that is not text",
      () => assertion({ client: { type: "webauthn.get", challenge: 5, origin: ORIGIN } }),
    ],
    ["attested credential data", () => assertion({ flags: 0x45 })],
    ["extension data", () => assertion({ flags: 0x85 })],
    ["a signature that is not DER", () => ({ ...assertion(), signature: Buffer.from("not der at all") })],
    [
      "a DER signature with trailing bytes",
      () => ({ ...assertion(), signature: Buffer.concat([assertion().signature, Buffer.from([0])]) }),
    ],
    [
      "a key that is not ES256",
      () => ({ ...assertion(), publicKey: Buffer.from([0xa1, 0x01, 0x03]).toString("base64url") }),
    ],
  ])("hands back %s", (_name, build) => {
    expect(() => verifyAssertion(build())).toThrow();
  });
});

describe("verifyAssertion with attested credential and extension data", () => {
  const AT = 0x40;
  const ED = 0x80;
  const UP_UV = 0x05;
  const withTail = (flags: number, tail: Buffer) =>
    assertion({ authenticatorData: Buffer.concat([authenticatorData(flags | UP_UV, 1), tail]) });
  const attested = Buffer.concat([Buffer.alloc(16), Buffer.from([0, 3]), Buffer.from("abc"), coseKey]);
  const extensions = Buffer.from([0xa1, 0x61, 0x61, 0x01]);

  it("accepts extension data that is one CBOR item", () => {
    expect(verifyAssertion(withTail(ED, extensions))).toEqual({ ok: true, signCount: 1 });
    expect(verifyAssertion(withTail(ED, Buffer.from([0xa0]))).ok).toBe(true);
  });

  it.each([
    ["null", Buffer.from([0xf6])],
    ["false", Buffer.from([0xf4])],
    ["an item followed by more bytes", Buffer.from([0xa0, 0x00])],
  ])("refuses extension data that is %s", (_name, tail) => {
    expect(verifyAssertion(withTail(ED, tail)).ok).toBe(false);
  });

  it("accepts attested credential data with an ES256 key, with or without extension data", () => {
    expect(verifyAssertion(withTail(AT, attested)).ok).toBe(true);
    expect(verifyAssertion(withTail(AT | ED, Buffer.concat([attested, extensions]))).ok).toBe(true);
  });

  it("refuses bytes left over after attested credential data and bytes the flags do not announce", () => {
    expect(verifyAssertion(withTail(AT, Buffer.concat([attested, Buffer.from("zz")]))).ok).toBe(false);
    expect(verifyAssertion(withTail(0, Buffer.from("zz"))).ok).toBe(false);
  });

  it.each([
    ["empty extension data, where the gem raises EOFError", ED, Buffer.alloc(0)],
    ["truncated extension data", ED, Buffer.from([0xa1, 0x61])],
    ["an extension in a type Node does not read", ED, Buffer.from([0x81, 0x01])],
    ["extension data that is not in its shortest form", ED, Buffer.from([0x18, 0x01])],
    ["truncated attested credential data", AT, attested.subarray(0, 10)],
    ["a key that is not ES256", AT, Buffer.concat([attested.subarray(0, 21), Buffer.from([0xa1, 0x01, 0x02])])],
  ])("hands back %s", (_name, flags, tail) => {
    expect(() => verifyAssertion(withTail(flags, tail))).toThrow();
  });
});

describe("decodeBase64Url", () => {
  it("pads when the padding is missing and takes either alphabet, like the gem", () => {
    expect(decodeBase64Url("YQ")?.toString()).toBe("a");
    expect(decodeBase64Url("YQ==")?.toString()).toBe("a");
    expect(decodeBase64Url("-_8")?.equals(Buffer.from([0xfb, 0xff]))).toBe(true);
    expect(decodeBase64Url("+/8=")?.equals(Buffer.from([0xfb, 0xff]))).toBe(true);
  });

  it("refuses what Ruby's strict decoder refuses", () => {
    expect(decodeBase64Url("Y")).toBeNull();
    expect(decodeBase64Url("YR==")).toBeNull();
    expect(decodeBase64Url("YQ=")).toBeNull();
    expect(decodeBase64Url("Y Q=")).toBeNull();
    expect(decodeBase64Url("YQ==YQ==")).toBeNull();
  });
});
