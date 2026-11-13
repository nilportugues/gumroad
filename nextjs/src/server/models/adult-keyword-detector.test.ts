import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/adult-keyword-detector.golden.json" with { type: "json" };
import { isAdult } from "./adult-keyword-detector.ts";

// The verdicts of AdultKeywordDetector.adult? on the inputs below, run in Ruby (app/services/adult_keyword_detector.rb).
describe("isAdult", () => {
  it.each(golden as { input: string | null; adult: boolean }[])("agrees with Ruby on %j", ({ input, adult }) => {
    expect(isAdult(input)).toBe(adult);
  });
});
