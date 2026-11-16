import { describe, expect, it } from "vitest";

import { displayedName } from "./installments.ts";

const LOREM = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";

describe("displayedName", () => {
  it("returns the name when the post has one", () => {
    expect(displayedName({ name: "Launch day", message: "<p>Body</p>" })).toBe("Launch day");
  });

  it("reads a blank name as missing and falls back to the message", () => {
    expect(displayedName({ name: "   ", message: "<p>Hello <b>world</b></p>" })).toBe("Hello world");
  });

  it("returns nil when there is neither a name nor a message", () => {
    expect(displayedName({ name: null, message: null })).toBeNull();
  });

  it("returns an empty string for an empty message", () => {
    expect(displayedName({ name: null, message: "" })).toBe("");
  });

  it("cuts the stripped message to 48 characters at the last word boundary", () => {
    expect(displayedName({ name: null, message: LOREM })).toBe("Lorem ipsum dolor sit amet consectetur...");
    expect(displayedName({ name: null, message: `<p>${LOREM}</p>` })).toBe("Lorem ipsum dolor sit amet consectetur...");
  });

  it("cuts mid-word when the message has no separator within reach", () => {
    expect(displayedName({ name: null, message: "x".repeat(60) })).toBe(`${"x".repeat(45)}...`);
  });
});
