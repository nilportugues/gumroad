import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AuthHashError, googleImageUrl } from "../models/social-google-auth.ts";

type Golden = Record<string, { ok: string } | { raises: string; message: string }>;
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "parity", "golden", "google-image-url.json"), "utf8"),
) as Golden;

// Ruby's answer, input by input (nextjs/parity/golden/google-image-url.rb). The output string of a scheme whose class this port does not print
// (ftp, file, ldap, ldaps, mailto) is not compared; whether the picture is accepted is.
const UNPRINTED = /^(ftp|file|ldaps?|mailto):/iu;

function outcome(input: string): { ok: string } | { raises: string } {
  try {
    return { ok: googleImageUrl(input) ?? "" };
  } catch (error) {
    if (error instanceof AuthHashError) return { raises: error.message };
    throw error;
  }
}

describe("URI.parse as omniauth-google-oauth2's image_url runs it", () => {
  const cases = Object.entries(golden);
  it("has the golden cases", () => {
    expect(cases.length).toBeGreaterThan(1000);
  });

  it.each(cases)("%j", (input, expected) => {
    const actual = outcome(input);
    if ("raises" in expected) expect(actual).toEqual({ raises: expected.message });
    else if (UNPRINTED.test(input)) expect(actual).toHaveProperty("ok");
    else expect(actual).toEqual({ ok: expected.ok });
  });
});
