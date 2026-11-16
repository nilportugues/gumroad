import { describe, expect, it } from "vitest";

import { basename, sanitizeFilename } from "./active-storage-attach.ts";
import { escapeUri } from "./profile-picture.ts";

describe("basename", () => {
  it("is the last path segment, query string included", () => {
    expect(basename("http://pbs.twimg.com/profile_images/42/photo_400x400.png")).toBe("photo_400x400.png");
    expect(basename("https://lh3.googleusercontent.com/a/AB=s400-c?sz=50")).toBe("AB=s400-c?sz=50");
  });

  it("ignores trailing slashes like File.basename", () => {
    expect(basename("https://example.com/a/b///")).toBe("b");
  });
});

describe("sanitizeFilename", () => {
  it("replaces what ActiveStorage::Filename#sanitized replaces and strips the ends", () => {
    expect(sanitizeFilename(" AB=s400-c?sz=50 ")).toBe("AB=s400-c-sz=50");
    expect(sanitizeFilename('a%b$c|d:e;f/g<h>i*j"k\\l')).toBe("a-b-c-d-e-f-g-h-i-j-k-l");
  });
});

describe("escapeUri", () => {
  it("leaves RFC 2396 reserved and unreserved characters alone", () => {
    expect(escapeUri("https://a.example.com/p/q_r-s.png?x=1&y=2;z,3+4@5:6$")).toBe(
      "https://a.example.com/p/q_r-s.png?x=1&y=2;z,3+4@5:6$",
    );
  });

  it("encodes the rest, percent signs and non-ASCII characters included, as URI::DEFAULT_PARSER.escape does", () => {
    expect(escapeUri("https://a.example.com/a b%41#é")).toBe("https://a.example.com/a%20b%2541%23%C3%A9");
  });
});
