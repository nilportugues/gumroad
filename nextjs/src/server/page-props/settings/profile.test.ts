import { beforeAll, describe, expect, it } from "vitest";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { shownProfilePosts } from "./profile.ts";

const SHOWN_ON_PROFILE = 2 ** 7;
const SEND_EMAILS = 2 ** 8;

const post = (id: number, flags: number) => ({
  id,
  name: `Post ${id}`,
  slug: `post-${id}`,
  flags,
  published_at: new Date(Date.UTC(2025, 0, id)),
});

describe("shownProfilePosts", () => {
  beforeAll(() => {
    process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "test-cipher-key-0123456789abcdef";
    process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "0";
  });

  it("keeps only posts shown on the profile, in the order given", () => {
    const shown = shownProfilePosts([post(3, SHOWN_ON_PROFILE | SEND_EMAILS), post(2, SEND_EMAILS), post(1, SHOWN_ON_PROFILE)]);

    expect(shown.map((entry) => entry.slug)).toEqual(["post-3", "post-1"]);
  });

  it("serializes the external id, name, slug and an ISO timestamp with milliseconds", () => {
    const [entry] = shownProfilePosts([post(7, SHOWN_ON_PROFILE)]);

    expect(entry).toEqual({ id: encrypt(7), name: "Post 7", slug: "post-7", published_at: "2025-01-07T00:00:00.000Z" });
  });

  it("returns nothing when no post is shown on the profile", () => {
    expect(shownProfilePosts([post(1, SEND_EMAILS)])).toEqual([]);
  });

  it("stops at 999 posts", () => {
    const many = Array.from({ length: 1000 }, (_, index) => post(index + 1, SHOWN_ON_PROFILE));

    expect(shownProfilePosts(many)).toHaveLength(999);
  });
});
