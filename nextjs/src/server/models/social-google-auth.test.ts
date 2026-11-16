import { describe, expect, it } from "vitest";

import {
  googleAuthData,
  googleImageUrl,
  isDeletedPlaceholderEmail,
  prune,
  reportedGoogleEmail,
  verifiedGoogleEmail,
} from "./social-google-auth.ts";

describe("googleAuthData", () => {
  it("reads the uid from sub and prunes empty info entries", () => {
    const data = googleAuthData({ sub: 42, name: "G Person", email: "g@example.com", email_verified: true, given_name: "" });
    expect(data.uid).toBe("42");
    expect(data.info).toEqual({
      name: "G Person",
      email: "g@example.com",
      unverified_email: "g@example.com",
      email_verified: true,
    });
    expect(data.rawInfo).not.toHaveProperty("given_name");
  });

  it("keeps the address out of info.email when Google did not verify it, but reports it", () => {
    const data = googleAuthData({ sub: "1", email: "g@example.com", email_verified: false });
    expect(data.info.email).toBeUndefined();
    expect(data.info.email_verified).toBe(false);
    expect(reportedGoogleEmail(data)).toBe("g@example.com");
    expect(verifiedGoogleEmail(data)).toBeNull();
  });

  it("treats a string email_verified as a boolean the way ActiveModel casts it", () => {
    expect(verifiedGoogleEmail(googleAuthData({ sub: "1", email: "a@example.com", email_verified: "false" }))).toBeNull();
    expect(verifiedGoogleEmail(googleAuthData({ sub: "1", email: "a@example.com", email_verified: "true" }))).toBe("a@example.com");
    expect(verifiedGoogleEmail(googleAuthData({ sub: "1", email: "a@example.com" }))).toBeNull();
  });

  it("has no uid when the answer has no sub", () => {
    expect(googleAuthData({ email: "a@example.com" }).uid).toBeNull();
  });
});

describe("googleImageUrl", () => {
  it("drops sz and re-encodes what is left", () => {
    expect(googleImageUrl("https://lh3.example.com/a/photo=s96-c?sz=50&x=a%20b")).toBe("https://lh3.example.com/a/photo=s96-c?x=a+b");
    expect(googleImageUrl("https://lh3.example.com/a/photo.jpg?sz=50")).toBe("https://lh3.example.com/a/photo.jpg");
  });

  it("writes a key with no value as an empty segment, as CGI.parse and encode_www_form do", () => {
    expect(googleImageUrl("https://lh3.example.com/a.jpg?x=a%20b&y&x=2")).toBe("https://lh3.example.com/a.jpg?x=a+b&x=2&");
  });

  it("repairs a doubled scheme and leaves a URL with no query alone", () => {
    expect(googleImageUrl("https:https://lh3.example.com/a.jpg")).toBe("https://lh3.example.com/a.jpg");
    expect(googleImageUrl(undefined)).toBeNull();
  });
});

describe("prune and the placeholder domain", () => {
  it("drops nil, empty strings, arrays and hashes but keeps false and zero", () => {
    expect(prune({ a: null, b: "", c: [], d: {}, e: { f: "" }, g: false, h: 0 })).toEqual({ g: false, h: 0 });
  });

  it("recognises the freed address of a closed account", () => {
    expect(isDeletedPlaceholderEmail("x@Deleted.Invalid")).toBe(true);
    expect(isDeletedPlaceholderEmail("x@example.com")).toBe(false);
  });
});
