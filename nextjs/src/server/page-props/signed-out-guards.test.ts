import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../controllers/application-controller.ts";

import type { GuardInput } from "./guards.ts";
import { SELLER_PAGES } from "./seller-pages.ts";
import { OAUTH_APPLICATION_PAGES, SETTINGS_PAGES } from "./settings/pages.ts";

// The route gate sends a signed-out request to Rails, but it only reads the session cookie's user id: a cookie naming a
// user that no longer loads, or a gate error (which answers "signed in"), still reaches the guard. Rails answers that
// with authenticate_user!'s redirect to the login page, so the guard hands the request back instead of failing it.
const signedOut: GuardInput = {
  context: { loggedInUser: null, currentSeller: null, impersonatedUser: null },
  config: {} as GuardInput["config"],
  url: new URL("https://gumroad.example.com/settings"),
  params: { id: "1", slug: "profile" },
  urlOptions: { protocol: "https", host: "gumroad.example.com" },
};

describe.each([
  ["settings", SETTINGS_PAGES],
  ["seller pages", SELLER_PAGES],
  ["oauth applications", OAUTH_APPLICATION_PAGES],
])("%s guards for a signed-out visitor", (_name, pages) => {
  const guarded = Object.entries(pages).filter(([, spec]) => spec.guard);

  it("covers at least one guarded page", () => {
    expect(guarded.length).toBeGreaterThan(0);
  });

  it.each(guarded)("%s hands the request back to Rails", async (_pattern, spec) => {
    await expect(spec.guard!(signedOut)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
