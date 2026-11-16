import { describe, expect, it } from "vitest";

import { maskToken, perFormCsrfToken, unmaskToken } from "./csrf.ts";

// Recorded from GET /users/confirmation/new (devise_confirmation_new_parity_spec.rb): the session's real token and the tokens Rails
// put in two of the page's forms.
const SESSION_TOKEN = "8IyDeC0OwT1wV6ZOUXe9lqZVD6TT3NM12EkJ3LMMNNc";
const RAILS_FORM_TOKENS = {
  "/users/confirmation": "rbaziot583LOVfZHijjxA6TbdmZQLVJQ3Ft0ohqIsdVIU84B_jAASyOJhAQEqQXPXD7Yv-80akWYzpjOjaQppQ",
  "/users/auth/google_oauth2": "e7QtE6dfEdkOLS95EPzyvfxfRieCXGASpygBbO9F0eLLVxKWZTXRWqrnpxfEX1SVs8e3gJqm71cbnk01x2zV_Q",
};

describe("perFormCsrfToken", () => {
  it.each(Object.entries(RAILS_FORM_TOKENS))("signs %s as Rails does", (path, railsToken) => {
    expect(unmaskToken(perFormCsrfToken(SESSION_TOKEN, path, "post"))).toEqual(unmaskToken(railsToken));
  });

  it("binds the token to the form's action", () => {
    const other = unmaskToken(perFormCsrfToken(SESSION_TOKEN, "/users/auth/apple", "post"));
    expect(other).not.toEqual(unmaskToken(RAILS_FORM_TOKENS["/users/confirmation"]));
  });

  it("masks with a fresh pad each time", () => {
    expect(maskToken(Buffer.alloc(32))).not.toBe(maskToken(Buffer.alloc(32)));
  });
});
