import { describe, expect, it } from "vitest";

import { DEFAULT_APPLICATION_SCOPES, generateUniqueToken } from "./oauth-application-writes.ts";

// Doorkeeper::OAuth::Helpers::UniqueToken.generate in the Rails app returned "6YMJ5RrYQW3ww0G4go89L0AzjZlmFbUZm2_0M9lJntE":
// SecureRandom.urlsafe_base64(32), 43 characters of the URL-safe alphabet, no padding.
describe("generateUniqueToken", () => {
  it("matches the shape of Doorkeeper's tokens, uids and secrets", () => {
    for (let i = 0; i < 50; i++) expect(generateUniqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 100 }, generateUniqueToken)).size).toBe(100);
  });
});

describe("DEFAULT_APPLICATION_SCOPES", () => {
  it("is Doorkeeper.configuration.public_scopes joined, as a new application stores it", () => {
    expect(DEFAULT_APPLICATION_SCOPES).toBe(
      "edit_products edit_emails view_sales mark_sales_as_shipped edit_sales revenue_share ifttt view_profile edit_profile view_payouts view_tax_data account",
    );
  });
});
