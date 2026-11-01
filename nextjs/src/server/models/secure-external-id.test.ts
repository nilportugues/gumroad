import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecureExternalId, secureExternalId } from "./secure-external-id.ts";

const SAVED = { ...process.env };
const NOW = new Date("2026-11-01T12:00:00Z");

describe("decryptSecureExternalId", () => {
  beforeEach(() => {
    process.env.SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION = "1";
    process.env.SECURE_EXTERNAL_ID__KEYS__1 = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    process.env.SECURE_EXTERNAL_ID__KEYS__2 = "p6o5n4m3l2k1j0i9h8g7f6e5d4c3b2a1";
  });
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it("reads back the id of a token for the same model and scope", () => {
    expect(decryptSecureExternalId("Purchase", secureExternalId("Purchase", 42n, "dispute_evidence"), "dispute_evidence", NOW)).toBe("42");
  });

  it("refuses another model, another scope and an expired token", () => {
    const token = secureExternalId("Purchase", 42n, "dispute_evidence", { expiresAt: new Date("2026-11-01T11:59:59Z") });
    expect(decryptSecureExternalId("Purchase", token, "dispute_evidence", NOW)).toBeNull();
    const live = secureExternalId("Purchase", 42n, "dispute_evidence", { expiresAt: new Date("2026-11-02T00:00:00Z") });
    expect(decryptSecureExternalId("Purchase", live, "dispute_evidence", NOW)).toBe("42");
    expect(decryptSecureExternalId("User", live, "dispute_evidence", NOW)).toBeNull();
    expect(decryptSecureExternalId("Purchase", live, "other", NOW)).toBeNull();
  });

  it("answers null for tokens that are not tokens", () => {
    for (const token of [undefined, null, 5, "", "not-a-token", Buffer.from("[]").toString("base64url"), Buffer.from('{"v":"9","d":"x"}').toString("base64url"), Buffer.from('{"v":"1","d":"a--b--c"}').toString("base64url")]) {
      expect(decryptSecureExternalId("Purchase", token, "dispute_evidence", NOW)).toBeNull();
    }
  });

  it("refuses a token whose message was tampered with", () => {
    const token = secureExternalId("Purchase", 42n, "dispute_evidence");
    const outer = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { v: string; d: string };
    const [data, iv, tag] = outer.d.split("--") as [string, string, string];
    const flipped = Buffer.from(data, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const forged = Buffer.from(JSON.stringify({ v: outer.v, d: [flipped.toString("base64"), iv, tag].join("--") })).toString("base64url");
    expect(decryptSecureExternalId("Purchase", forged, "dispute_evidence", NOW)).toBeNull();
  });
});
