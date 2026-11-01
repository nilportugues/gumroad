import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../controllers/application-controller.ts";
import { InstagramSignedRequest } from "./instagram-signed-request.ts";

const SECRET = "secret";
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const sign = (payload: string) => `${b64(createHmac("sha256", SECRET).update(b64(payload)).digest())}.${b64(payload)}`;
const request = new InstagramSignedRequest(SECRET);

describe("InstagramSignedRequest#parse", () => {
  it("reads an integer user id beyond 2^53 from the source text", () => {
    expect(request.parse(sign('{"algorithm":"hmac-sha256","user_id":17841400000000001}'))).toEqual({ user_id: "17841400000000001" });
  });

  it("returns null for another algorithm, a bad signature and a missing secret", () => {
    expect(request.parse(sign('{"algorithm":"HMAC-SHA1","user_id":1}'))).toBeNull();
    expect(request.parse(`${b64("x".repeat(32))}.${b64("{}")}`)).toBeNull();
    expect(new InstagramSignedRequest("").parse(sign('{"algorithm":"HMAC-SHA256"}'))).toBeNull();
  });

  // Base64.urlsafe_decode64 is strict: non-zero trailing bits, stray characters and a lone character raise ArgumentError in Ruby.
  it.each(["QR==", "Q", "Q Q=", "QQ=A", "!!!"])("rejects %j as a signature", (signature) => {
    expect(request.parse(`${signature}.${b64("{}")}`)).toBeNull();
  });

  it("hands back a payload that is not an object", () => {
    expect(() => request.parse(sign("[1]"))).toThrow(HandBackToRails);
    expect(request.parse(sign('"algorithm"'))).toBeNull();
  });

  it("verifies confirmation codes the way the controller issues them", () => {
    const code = request.confirmationCode("17841400000000001");
    expect(code).toMatch(/^[0-9a-f]{48}$/u);
    expect(request.validConfirmationCode(code)).toBe(true);
    expect(request.validConfirmationCode(`${code.slice(0, 24)}${"0".repeat(24)}`)).toBe(false);
    expect(request.validConfirmationCode("invalid")).toBe(false);
  });
});
