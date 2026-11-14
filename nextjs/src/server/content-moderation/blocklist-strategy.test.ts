import { describe, expect, it } from "vitest";

import { blocklistWords, performBlocklist } from "./blocklist-strategy.ts";

describe("performBlocklist", () => {
  it("flags a whole-word match and reports the blocked word in lower case", () => {
    expect(performBlocklist("Guaranteed CASINO bonus", ["casino"])).toEqual({
      status: "flagged",
      reasoning: ["Matched blocked word: casino"],
    });
  });

  it("does not flag a word that only appears inside a longer word", () => {
    expect(performBlocklist("casinos and scamming", ["casino", "scam"])).toEqual({ status: "compliant", reasoning: [] });
  });

  it("treats a letter with a diacritic as part of the word, as Ruby's \\b does for UTF-8", () => {
    expect(performBlocklist("un café noir", ["café"]).status).toBe("flagged");
    expect(performBlocklist("cafébar", ["café"]).status).toBe("compliant");
  });

  it("escapes regular expression characters in a blocked phrase", () => {
    expect(performBlocklist("buy c++ fast", ["c++ fast"]).status).toBe("flagged");
    expect(performBlocklist("buy cxx fast", ["c++ fast"]).status).toBe("compliant");
  });

  it("reports every matched word in list order", () => {
    expect(performBlocklist("alpha beta", ["beta", "alpha", "gamma"]).reasoning).toEqual([
      "Matched blocked word: beta",
      "Matched blocked word: alpha",
    ]);
  });

  it("passes everything when the blocklist is empty", () => {
    expect(performBlocklist("casino", [])).toEqual({ status: "compliant", reasoning: [] });
  });
});

describe("blocklistWords", () => {
  it("merges YAML and environment words, lower-cased, de-duplicated and without blanks", () => {
    expect(blocklistWords(["Casino", "scam"], " SCAM, ,telegram ,")).toEqual(["casino", "scam", "telegram"]);
  });

  it("returns nothing for an empty environment value and no YAML words", () => {
    expect(blocklistWords([], "")).toEqual([]);
  });
});
