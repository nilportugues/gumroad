import { describe, expect, it } from "vitest";

import { NotPortedError } from "../../models/user.ts";

import { findAdminRoute } from "./registry.ts";
import { notesParam, parseThresholdCents } from "./user-watch.ts";

describe("parseThresholdCents", () => {
  it("turns a decimal number of dollars into cents", () => {
    expect(parseThresholdCents("200")).toBe(20_000n);
    expect(parseThresholdCents("12.5")).toBe(1_250n);
    expect(parseThresholdCents("+7")).toBe(700n);
  });

  it("rounds half a cent up like BigDecimal#round", () => {
    expect(parseThresholdCents("350.505")).toBe(35_051n);
    expect(parseThresholdCents("350.504")).toBe(35_050n);
    expect(parseThresholdCents("0.005")).toBe(1n);
  });

  it("answers nil for zero, negatives and amounts that round to zero", () => {
    expect(parseThresholdCents("0")).toBeNull();
    expect(parseThresholdCents("-5")).toBeNull();
    expect(parseThresholdCents("0.004")).toBeNull();
  });

  it("answers nil for the non-finite words and for text BigDecimal rejects", () => {
    for (const word of ["Infinity", "-Infinity", "NaN", "abc"]) expect(parseThresholdCents(word)).toBeNull();
  });

  it("reads a whole number with a plain exponent", () => {
    expect(parseThresholdCents("1e2")).toBe(10_000n);
    expect(parseThresholdCents("3E1")).toBe(3_000n);
    expect(parseThresholdCents("0e5")).toBeNull();
  });

  it("hands back shapes BigDecimal reads in other ways", () => {
    for (const text of ["1e-2", "1.5e2", "1e+2", "1e999", "1_000", " 5 ", "5.", "0x10"])
      expect(() => parseThresholdCents(text)).toThrow(NotPortedError);
  });

  it("hands back an amount past the bigint column", () => {
    expect(() => parseThresholdCents("99999999999999999999999")).toThrow(NotPortedError);
  });

  it("reads a JSON integer as its decimal text", () => {
    expect(parseThresholdCents(200)).toBe(20_000n);
  });
});

describe("notesParam", () => {
  it("keeps text and turns blank or missing notes into null", () => {
    expect(notesParam("Review")).toBe("Review");
    expect(notesParam("  ")).toBeNull();
    expect(notesParam(null)).toBeNull();
    expect(notesParam(undefined)).toBeNull();
  });

  it("hands back notes that are not text", () => {
    expect(() => notesParam({ a: 1 })).toThrow(NotPortedError);
    expect(() => notesParam(5)).toThrow(NotPortedError);
  });
});

describe("watchlist routes", () => {
  it("serves watch, update_watch and unwatch as POSTs on both hosts", () => {
    for (const action of ["watch", "update_watch", "unwatch"]) {
      expect(findAdminRoute("POST", `/internal/admin/users/${action}`)?.route.pattern).toBe(
        `/internal/admin/users/${action}`,
      );
      expect(findAdminRoute("POST", `/api/internal/admin/users/${action}`)).not.toBeNull();
      expect(findAdminRoute("GET", `/internal/admin/users/${action}`)).toBeNull();
    }
  });
});
