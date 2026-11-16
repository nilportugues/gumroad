import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NotPortedError } from "../models/user.ts";

import { numberWithDelimiter } from "./number-with-delimiter.ts";

type Case = { input: string | null; output: string };

const cases = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__", "number-with-delimiter.golden.json"), "utf8"),
) as Case[];

describe("numberWithDelimiter", () => {
  it.each(cases.map((c) => [JSON.stringify(c.input), c] as const))(
    "matches ActionView for %s or refuses it",
    (_name, { input, output }) => {
      let figure: string;
      try {
        figure = `$${numberWithDelimiter(input)}`;
      } catch (error) {
        // A spelling Ruby's Float() might read goes to Rails.
        expect(error).toBeInstanceOf(NotPortedError);
        return;
      }
      expect(figure).toBe(output);
    },
  );

  it("serves the figures a payout is stored as", () => {
    const served = cases.filter(
      ({ input }) =>
        input === null ||
        /^[+-]?\d+(\.\d+)?$/u.test(input) ||
        input === "n/a" ||
        input === "1,234" ||
        input === "$1234",
    );
    expect(served.length).toBeGreaterThanOrEqual(12);
    for (const { input, output } of served) expect(`$${numberWithDelimiter(input)}`).toBe(output);
  });
});
