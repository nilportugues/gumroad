import { describe, expect, it } from "vitest";

import { RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";
import { csvSafeGenerate } from "./csv-safe.ts";

// Expectations are the ones in spec/lib/utilities/csv_safe_spec.rb.
describe("CsvSafe parity with Ruby", () => {
  it("preserves positive and negative numeric strings", () => {
    expect(csvSafeGenerate([["+100", "+123.45", "+999"]])).toBe("+100,+123.45,+999\n");
    expect(csvSafeGenerate([["-100", "-123.45", "-999"]])).toBe("-100,-123.45,-999\n");
  });

  it("preserves mixed numeric values", () => {
    expect(csvSafeGenerate([["-100", "+200", "300", "-1.5", "+2.75"]])).toBe("-100,+200,300,-1.5,+2.75\n");
  });

  it("sanitizes formula injection with equals", () => {
    expect(csvSafeGenerate([["=1+1", "=SUM(A1:A10)", "=cmd|' /C calc'!A0"]])).toBe("'=1+1,'=SUM(A1:A10),'=cmd|' /C calc'!A0\n");
  });

  it("sanitizes non-numeric strings starting with plus or minus", () => {
    expect(csvSafeGenerate([["+abc", "+1+1", "+test"]])).toBe("'+abc,'+1+1,'+test\n");
    expect(csvSafeGenerate([["-abc", "-1+1", "-test"]])).toBe("'-abc,'-1+1,'-test\n");
  });

  it("sanitizes at-sign, pipe and percent prefixes", () => {
    expect(csvSafeGenerate([["@SUM(1+1)", "@A1"]])).toBe("'@SUM(1+1),'@A1\n");
    expect(csvSafeGenerate([["|test", "%test"]])).toBe("'|test,'%test\n");
  });

  it("sanitizes tab and carriage return prefixes, quoting the carriage return", () => {
    expect(csvSafeGenerate([["\t=1+1", "\r=1+1"]])).toBe("'\t=1+1,\"'\r=1+1\"\n");
  });

  it("preserves normal text", () => {
    expect(csvSafeGenerate([["hello", "world", "123", "test@example.com"]])).toBe("hello,world,123,test@example.com\n");
  });

  it("writes nil as an empty field and an empty string as a quoted pair", () => {
    expect(csvSafeGenerate([[null, "", "test"]])).toBe(',"",test\n');
  });

  it("writes Integers as is and Floats as Float#to_s", () => {
    expect(csvSafeGenerate([[100, -200, new RubyFloat(3.14), new RubyFloat(-5.67)]])).toBe("100,-200,3.14,-5.67\n");
    expect(csvSafeGenerate([[new RubyFloat(10), new RubyFloat(-0)]])).toBe("10.0,-0.0\n");
  });

  it("handles decimals with and without a leading digit", () => {
    expect(csvSafeGenerate([["+0.5", "-0.5", "+.5", "-.5"]])).toBe("+0.5,-0.5,'+.5,'-.5\n");
  });

  it("sanitizes HYPERLINK and DDE payloads, doubling the quotes inside", () => {
    expect(csvSafeGenerate([[`=HYPERLINK("http://attacker.invalid","click")`]])).toBe(
      `"'=HYPERLINK(""http://attacker.invalid"",""click"")"\n`,
    );
    expect(csvSafeGenerate([["=cmd|' /C calc'!A0", "=10+20+cmd|' /C calc'!A0"]])).toBe(
      "'=cmd|' /C calc'!A0,'=10+20+cmd|' /C calc'!A0\n",
    );
  });

  it("handles a row mixing safe and dangerous values", () => {
    expect(csvSafeGenerate([["normal", "+100", "-200", "=1+1", "@SUM()", "+abc", "test"]])).toBe(
      "normal,+100,-200,'=1+1,'@SUM(),'+abc,test\n",
    );
  });
});
