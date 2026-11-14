import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { issuePlayerGrant, PLAYER_GRANT_VALID_FOR_MS, verifiedPlayerGrant } from "./player-grant.ts";

describe("issuePlayerGrant", () => {
  beforeEach(() => {
    vi.stubEnv("SECRET_KEY_BASE", "a".repeat(64));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const data = { token: "abc", purchase_id: 1, seller_id: 2, site_prefix: "builds/1/1/site" };
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("opens under the verifier for its own token", () => {
    expect(verifiedPlayerGrant(issuePlayerGrant(data, { now }), "abc", undefined, now)).toEqual(data);
  });

  it("is refused for another token", () => {
    expect(verifiedPlayerGrant(issuePlayerGrant(data, { now }), "other", undefined, now)).toBeNull();
  });

  it("is refused once its validity has passed", () => {
    const later = new Date(now.getTime() + PLAYER_GRANT_VALID_FOR_MS);
    expect(verifiedPlayerGrant(issuePlayerGrant(data, { now }), "abc", undefined, later)).toBeNull();
  });

  it("is refused for another purpose", () => {
    expect(verifiedPlayerGrant(issuePlayerGrant(data, { now }), "abc", "product_build_player_save", now)).toBeNull();
  });
});
