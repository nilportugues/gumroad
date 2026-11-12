import { describe, expect, it } from "vitest";

import { rackTopLevelParams } from "./rails-params.ts";

describe("rackTopLevelParams", () => {
  it("separates a flat key with a value, with an empty value and without one", () => {
    const params = rackTopLevelParams("a=1&b=&c");

    expect(params.get("a")).toEqual({ nested: false, value: "1" });
    expect(params.get("b")).toEqual({ nested: false, value: "" });
    expect(params.get("c")).toEqual({ nested: false, value: null });
  });

  it("lets the last pair of a flat key win and decodes names and values", () => {
    const params = rackTopLevelParams("?utm%5Fx=1&a=x+y&a=%C3%A9");

    expect([...params.keys()]).toEqual(["utm_x", "a"]);
    expect(params.get("a")).toEqual({ nested: false, value: "é" });
  });

  it("reads one level of list and hash as the key they hang from", () => {
    const params = rackTopLevelParams("tags[]=a&tags[]=b&filter[kind]=x&filter[other]=y");

    expect(params.get("tags")).toEqual({ nested: true });
    expect(params.get("filter")).toEqual({ nested: true });
  });

  it.each(["a=1&a[b]=2", "a[]=1&a[b]=2", "a[b][c]=1", "[x]=1", "a=%E0%A4%A", "a%ZZ=1"])("hands back %s", (query) => {
    expect(() => rackTopLevelParams(query)).toThrow();
  });
});
