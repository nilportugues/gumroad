import { describe, expect, it } from "vitest";

import { faradayQuery, humanize } from "./omniauth-phases.ts";

describe("faradayQuery", () => {
  it("sorts the keys and writes a nil value as the bare key", () => {
    expect(faradayQuery({ state: "abc", client_id: null, access_type: "offline" })).toBe(
      "access_type=offline&client_id&state=abc",
    );
  });

  it("escapes every byte but letters, digits and . ~ _ -, and writes a space as a plus", () => {
    expect(faradayQuery({ login_hint: "buyer@example.com", scope: "email profile", note: "a!b'c(d)é" })).toBe(
      "login_hint=buyer%40example.com&note=a%21b%27c%28d%29%C3%A9&scope=email+profile",
    );
  });
});

describe("humanize", () => {
  it("matches String#humanize", () => {
    expect(humanize("access_denied")).toBe("Access denied");
    expect(humanize("CSRF detected")).toBe("Csrf detected");
    expect(humanize("user_id")).toBe("User");
    expect(humanize("_leading")).toBe("Leading");
    expect(humanize("ActionController::InvalidAuthenticityToken")).toBe("Actioncontroller::invalidauthenticitytoken");
    expect(humanize("")).toBe("");
  });
});
