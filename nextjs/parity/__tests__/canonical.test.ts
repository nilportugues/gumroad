import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  cookieValue,
  dbValue,
  diff,
  json,
  type Json,
  parseJson,
  resolveDateToken,
  resolveTimeToken,
  type Tables,
  timeToken,
} from "../src/canonical";

// Same vectors as canonical_test.rb, so the recorder and the replayer agree byte for byte.
type Vectors = {
  now: string;
  dbValues: { type: string; raw: string | null; expected: Json }[];
  json: { input: Json; expected: Json }[];
  cookieValues: { name: string; value: string; expected: string }[];
  diff: { before: Tables; after: Tables; expected: Json };
};
const vectors = parseJson(readFileSync(new URL("./canonical-vectors.json", import.meta.url), "utf8")) as unknown as Vectors;
const now = new Date(vectors.now);

describe("canonical forms shared with the Ruby recorder", () => {
  it.each(vectors.dbValues)("reads a $type column holding $raw", ({ type, raw, expected }) => {
    expect(dbValue(raw, type, now)).toEqual(expected);
  });

  it("normalises times inside strings and keeps unsafe integers exact", () => {
    for (const vector of vectors.json) expect(json(vector.input, now)).toEqual(vector.expected);
  });

  it.each(vectors.cookieValues)("reads the $name cookie's value as $expected", ({ name, value, expected }) => {
    expect(cookieValue(name, value)).toBe(expected);
  });

  it("diffs inserted, updated and deleted rows per table", () => {
    expect(diff(vectors.diff.before, vectors.diff.after, now)).toEqual(vectors.diff.expected);
  });
});

describe("time tokens", () => {
  it.each(["<now>", "<now-30s>", "<now+25m>", "<now-48h>"])("resolves %s back to the offset it encodes", (token) => {
    expect(timeToken(resolveTimeToken(token, now)!, now)).toBe(token);
  });

  it("resolves date tokens against the UTC date of now", () => {
    expect(resolveDateToken("<today-3d>", now)?.toISOString()).toBe("2026-10-28T00:00:00.000Z");
  });

  it("leaves strings that are not tokens alone", () => {
    expect(resolveTimeToken("2026-10-31 12:00:00", now)).toBeNull();
  });
});
