import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { redirectUriAllowed } from "./oauth-redirect-uri.ts";

type Case = { requested: string; registered: string; result: boolean | { $raises: string } };
const cases = JSON.parse(
  readFileSync(new URL("./__fixtures__/oauth-redirect-uri.golden.json", import.meta.url), "utf8"),
) as Case[];

describe("redirectUriAllowed", () => {
  it.each(cases.map((entry) => [JSON.stringify([entry.requested, entry.registered]), entry] as const))(
    "answers like URIChecker.valid_for_authorization? for %s",
    (_name, entry) => {
      expect(redirectUriAllowed(entry.requested, entry.registered)).toBe(entry.result);
    },
  );

  it("covers both outcomes", () => {
    expect(cases.some((entry) => entry.result === true)).toBe(true);
    expect(cases.some((entry) => entry.result === false)).toBe(true);
  });

  it("hands a registered ftp, file, ldap or mailto URI back before judging", () => {
    for (const registered of ["ftp://app.example.com/cb", "file:///cb", "ldap://app.example.com", "mailto:a@example.com"])
      expect(() => redirectUriAllowed("https://app.example.com/cb", registered)).toThrow(/not ported/u);
  });
});
