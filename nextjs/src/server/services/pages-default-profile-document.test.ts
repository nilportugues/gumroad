import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultProfileDocument } from "./pages-default-profile-document.ts";

type Case = {
  name: string;
  seller: { name: string | null; username: string | null; external_id: string; bio: string | null };
  profile: { background_color: string | null; highlight_color: string | null } | null;
  hands_back: boolean;
  document: string | null;
};
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/pages-default-profile-document.golden.json"), "utf8"),
) as { cases: Case[] };

// User#username falls back to the external id; User#name_or_username prefers a present name
const nameOrUsername = (seller: Case["seller"]) => {
  if (seller.name !== null && seller.name.trim() !== "") return seller.name;
  return seller.username === null || seller.username.trim() === "" ? seller.external_id : seller.username;
};

// The recording host has no asset host, so the default avatar is a bare path.
const AVATAR_URL = "/images/gumroad-default-avatar-5.png";

describe("Pages::DefaultProfileDocument against Ruby (nextjs/scripts/golden/pages-default-profile-document.rb)", () => {
  it.each(golden.cases.filter((c) => !c.hands_back).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(
      defaultProfileDocument({
        nameOrUsername: nameOrUsername(c.seller),
        bio: c.seller.bio,
        avatarUrl: AVATAR_URL,
        profile: c.profile,
      }),
    ).toBe(c.document);
  });

  it("covers every case the generator records", () => {
    expect(golden.cases.length).toBe(18);
  });
});
