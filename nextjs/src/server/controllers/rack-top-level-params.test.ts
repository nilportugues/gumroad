import { describe, expect, it } from "vitest";

import { isRackBadRequest, rackTopLevelParams } from "./rails-params.ts";

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

  it("reads a list or hash of any depth as the key it hangs from", () => {
    const params = rackTopLevelParams("a[b][c]=1&a[b][d]=2&a[e][]=3&f[g][h][i]=4&a[b][c]=5");

    expect(params.get("a")).toEqual({ nested: true });
    expect(params.get("f")).toEqual({ nested: true });
  });

  it("lets a flat pair overwrite a hash or a list and a repeated flat name", () => {
    const params = rackTopLevelParams("a[b][c]=1&a[b]=2&d[]=1&d=2&e=1&e=3");

    expect(params.get("a")).toEqual({ nested: true });
    expect(params.get("d")).toEqual({ nested: false, value: "2" });
    expect(params.get("e")).toEqual({ nested: false, value: "3" });
  });

  it("reads a name that starts with a bracket or leaves one open as Rack 3.2 does", () => {
    const params = rackTopLevelParams("[utm_source]=1&[]=2&a[b=3&c[][d]=4&e]=5&f[[g]=6");

    expect([...params.keys()]).toEqual(["[utm_source]", "[]", "a", "c", "e]", "f"]);
    expect(params.get("[utm_source]")).toEqual({ nested: false, value: "1" });
    expect(params.get("a")).toEqual({ nested: true });
    expect(params.get("c")).toEqual({ nested: true });
  });

  it("keeps a bare name that is replaced by a list or a hash", () => {
    const params = rackTopLevelParams("a&a[]=1&b&b[c]=2");

    expect(params.get("a")).toEqual({ nested: true });
    expect(params.get("b")).toEqual({ nested: true });
  });

  it.each([
    "a=1&a[b]=2",
    "a[]=1&a[b]=2",
    "a[b]=1&a[]=2",
    "a[b]=1&a[b][c]=2",
    "a=1&a[]=2",
    "a=&a[]=1",
    "utm_a[b]=1&utm_a[b][c]=1",
  ])("hands back %s, which Rack raises a ParameterTypeError for", (query) => {
    expect(() => rackTopLevelParams(query)).toThrow(/used as a flat value/u);
    try {
      rackTopLevelParams(query);
    } catch (error) {
      expect(isRackBadRequest(error)).toBe(false);
    }
  });

  it.each(["a=%zz", "a=%", "a%ZZ=1", "a=%E0%A4%A", "a=%4"])(
    "tells %s apart as the 400 of an invalid percent escape",
    (query) => {
      try {
        rackTopLevelParams(query);
        expect.unreachable();
      } catch (error) {
        expect(isRackBadRequest(error)).toBe(true);
      }
    },
  );

  it("hands back a name nested past Rack's depth limit", () => {
    expect(() => rackTopLevelParams(`a${"[b]".repeat(40)}=1`)).toThrow(/nested too deeply/u);
  });
});
