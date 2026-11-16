import { describe, expect, it } from "vitest";

import { numberToSi } from "./home-layout.ts";
import { imageTag, linkTo, tagOptions } from "./html.ts";

describe("numberToSi", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [12_345, "12.3K"],
    [19_999, "19.9K"],
    [2_000_000, "2M"],
  ])("writes %i as %s", (number, expected) => {
    expect(numberToSi(number)).toBe(expected);
  });
});

describe("tag helpers", () => {
  it("puts href last on a link and src last on an image", () => {
    expect(linkTo("a&b", "/x", { class: "c" }).value).toBe('<a class="c" href="/x">a&amp;b</a>');
    expect(imageTag("/i.svg", { alt: "" }).value).toBe('<img alt="" src="/i.svg" />');
  });

  it("expands aria in place and drops nil attributes", () => {
    expect(tagOptions({ target: "_blank", aria: { label: "L" }, rel: null })).toBe('target="_blank" aria-label="L"');
  });
});
