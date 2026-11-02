import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { distanceOfTimeInWords } from "./time-ago-in-words.ts";

type Case = { from: string; to: string; words: string };
const cases = JSON.parse(readFileSync(new URL("./__fixtures__/time-ago-in-words.golden.json", import.meta.url), "utf8")) as Case[];

describe("distanceOfTimeInWords", () => {
  it.each(cases.map((c) => [`${c.from} to ${c.to}`, c] as const))("%s matches ActionView", (_name, c) => {
    expect(distanceOfTimeInWords(new Date(c.from), new Date(c.to))).toBe(c.words);
  });
});
