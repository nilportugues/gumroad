import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { postSnippet, socialImage, truncatedDescription } from "./post.ts";
import { distanceOfTimeInWords } from "./time-ago.ts";

// storefront-posts.golden.json: the real helpers (scripts/golden/storefront-posts.rb).
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/storefront-posts.golden.json", import.meta.url), "utf8")) as {
  now: string;
  time_ago: [number, string][];
  leap: [string, string, string][];
  messages: { message: string; snippet: string; truncated_description: string; social_image: { url: string | null; caption: string | null } }[];
};

describe("time_ago_in_words", () => {
  const now = new Date(golden.now);

  it.each(golden.time_ago)("words %i seconds like Rails", (seconds, words) => {
    expect(distanceOfTimeInWords(new Date(now.getTime() - seconds * 1000), now)).toBe(words);
  });

  it.each(golden.leap)("counts the leap years between %s and %s", (from, to, words) => {
    expect(distanceOfTimeInWords(new Date(from), new Date(to))).toBe(words);
  });
});

describe("the readings of a post message", () => {
  it.each(golden.messages.map((entry) => [entry.message, entry] as const))("reads %j like Rails", (_message, entry) => {
    expect(postSnippet(entry.message)).toBe(entry.snippet);
    expect(truncatedDescription(entry.message)).toBe(entry.truncated_description);
    expect(socialImage(entry.message)).toEqual(entry.social_image);
  });
});
