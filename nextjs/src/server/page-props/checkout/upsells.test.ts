import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";

import { listParams } from "./upsells.ts";

describe("listParams", () => {
  it("defaults to the first page, no search and ascending", () => {
    expect(listParams("")).toEqual({ page: 1, query: null, sortKey: null, direction: "asc" });
  });

  it("reads page with String#to_i and clamps it to 1", () => {
    expect(listParams("page=3abc").page).toBe(3);
    expect(listParams("page=-4").page).toBe(1);
    expect(listParams("page=x").page).toBe(1);
  });

  it("treats a blank query as absent and keeps a search as typed", () => {
    expect(listParams("query=%20%20").query).toBeNull();
    expect(listParams("query=50%25 off").query).toBe("50% off");
  });

  it("reads the sort key and direction", () => {
    expect(listParams("sort[key]=name&sort[direction]=desc")).toMatchObject({ sortKey: "name", direction: "desc" });
    expect(listParams("sort[key]=status&sort[direction]=sideways").direction).toBe("asc");
    expect(listParams("sort[key]=revenue&sort[direction]=desc")).toMatchObject({
      sortKey: "revenue",
      direction: "desc",
    });
  });

  it("hands back parameters that are not text", () => {
    expect(() => listParams("sort=name")).toThrow(HandBackToRails);
    expect(() => listParams("page[]=2")).toThrow(HandBackToRails);
    expect(() => listParams("query[]=a")).toThrow(HandBackToRails);
  });
});
