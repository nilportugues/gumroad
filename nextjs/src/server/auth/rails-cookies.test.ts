import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/rails-cookies.golden.json" with { type: "json" };
import {
  deriveRailsCookieSecrets,
  readEncryptedCookie,
  readSignedCookie,
  writeEncryptedCookie,
  writeSignedCookie,
} from "./rails-cookies.ts";

// Vectors come from ActionDispatch's own cookie jar: __fixtures__/generate-rails-cookies.rb.
const secrets = deriveRailsCookieSecrets(golden.secret_key_base);
const now = new Date("2026-10-31T00:00:00Z");
const read = (kind: string, name: string, raw: string) =>
  kind === "encrypted" ? readEncryptedCookie(secrets, name, raw, now) : readSignedCookie(secrets, name, raw, now);

describe("Rails cookie jar parity", () => {
  it.each(golden.cookies.map((c) => [c.label, c] as const))("reads %s as Rails does", (_label, vector) => {
    expect(read(vector.kind, vector.name, vector.raw)).toEqual(vector.expected);
  });

  const pinned = golden.cookies.filter((c) => c.iv && c.label.includes("current"));
  it.each(pinned.map((c) => [c.label, c] as const))("writes %s byte for byte", (_label, vector) => {
    const written = writeEncryptedCookie(secrets, vector.name, vector.value, {
      expiresAt: vector.expires ? new Date(vector.expires) : null,
      iv: Buffer.from(vector.iv!, "hex"),
    });
    expect(written).toBe(vector.raw);
  });

  it("writes the current_seller_id and no-expiry vectors byte for byte", () => {
    for (const label of ["current_seller_id", "session, no expiry", "session, expired"]) {
      const vector = golden.cookies.find((c) => c.label === label)!;
      const written = writeEncryptedCookie(secrets, vector.name, vector.value, {
        expiresAt: vector.expires ? new Date(vector.expires) : null,
        iv: Buffer.from(vector.iv!, "hex"),
      });
      expect(written).toBe(vector.raw);
    }
  });

  it("signs the remember token byte for byte", () => {
    const vector = golden.cookies.find((c) => c.label === "remember token, current SHA256 key")!;
    expect(writeSignedCookie(secrets, vector.name, vector.value, { expiresAt: new Date(vector.expires!) })).toBe(vector.raw);
  });

  it("round-trips with a random IV", () => {
    const value = { "warden.user.user.key": [[7], "salt"], session_id: "abc" };
    const raw = writeEncryptedCookie(secrets, "_gumroad_app_session", value, { expiresAt: new Date("2100-01-01T00:00:00Z") });
    expect(readEncryptedCookie(secrets, "_gumroad_app_session", raw, now)).toEqual(value);
  });

  it("rejects cookies made with another secret_key_base", () => {
    const other = deriveRailsCookieSecrets("b".repeat(128));
    const raw = writeEncryptedCookie(other, "_gumroad_app_session", { a: 1 });
    expect(readEncryptedCookie(secrets, "_gumroad_app_session", raw, now)).toBeNull();
  });

  it("treats an absent cookie as nil", () => {
    expect(readEncryptedCookie(secrets, "_gumroad_app_session", undefined, now)).toBeNull();
    expect(readSignedCookie(secrets, "remember_user_token", "", now)).toBeNull();
  });
});
