import { describe, expect, it } from "vitest";

import { blankFieldErrors, joinErrors } from "./oauth-applications-mutations.ts";

// The alerts spec/requests/oauth_applications_signed_in_spec.rb asserts for Rails ("refuses an application ...").
describe("blank oauth application fields", () => {
  it("names a blank name", () => {
    expect(joinErrors(blankFieldErrors({ name: "   ", redirect_uri: "https://example.com/callback" }))).toBe("Name can't be blank");
  });

  it("names a blank redirect URI", () => {
    expect(joinErrors(blankFieldErrors({ name: "No redirect", redirect_uri: "" }))).toBe("Redirect URI can't be blank");
  });

  it("names both, name first", () => {
    expect(joinErrors(blankFieldErrors({ name: "", redirect_uri: "" }))).toBe("Name can't be blank and Redirect URI can't be blank");
  });
});
