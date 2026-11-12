import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { redirectUriAllowed } from "./oauth-redirect-uri.ts";

type Case = { requested: string; registered: string; result: boolean | { $raises: string } };
const cases = JSON.parse(
  readFileSync(new URL("./__fixtures__/oauth-redirect-uri.golden.json", import.meta.url), "utf8"),
) as Case[];

// Shapes the port refuses to judge (it throws before any write): IP literals and the schemes with their own Ruby URI class.
const handedBack = (url: string) => /^\[|:\/\/\[|^(?:ftp|file|ldaps?|mailto|wss?):/iu.test(url);

describe("redirectUriAllowed", () => {
  it.each(cases.map((entry) => [JSON.stringify([entry.requested, entry.registered]), entry] as const))(
    "answers like URIChecker.valid_for_authorization? for %s",
    (_name, entry) => {
      if (handedBack(entry.requested)) {
        expect(() => redirectUriAllowed(entry.requested, entry.registered)).toThrow(/not ported/u);
        return;
      }
      expect(redirectUriAllowed(entry.requested, entry.registered)).toBe(entry.result);
    },
  );

  it("covers both outcomes", () => {
    expect(cases.some((entry) => entry.result === true)).toBe(true);
    expect(cases.some((entry) => entry.result === false)).toBe(true);
  });
});
