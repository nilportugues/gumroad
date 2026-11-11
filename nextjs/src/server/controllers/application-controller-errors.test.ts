import { describe, expect, it } from "vitest";

import { Errors, RecordInvalid } from "../models/runtime/errors.ts";

import { exceptionStatus, RoutingError } from "./application-controller.ts";

describe("exceptionStatus", () => {
  it("answers 422 for a RecordInvalid raised by save! or update!", () => {
    const errors = new Errors();
    errors.add("role", "is not included in the list");

    expect(exceptionStatus(new RecordInvalid(errors))).toBe(422);
  });

  it("answers 404 for a RoutingError", () => {
    expect(exceptionStatus(new RoutingError("Not Found"))).toBe(404);
  });

  it("answers 500 for any other error", () => {
    expect(exceptionStatus(new Error("boom"))).toBe(500);
  });
});
