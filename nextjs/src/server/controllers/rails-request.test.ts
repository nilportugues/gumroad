import { describe, expect, it } from "vitest";

import { queryParamStrings, type RailsRequest } from "./rails-request.ts";

const strings = (queryString: string) => queryParamStrings({ queryString } as RailsRequest, "purchase_id");

describe("queryParamStrings", () => {
  it("is empty without the key", () => {
    expect(strings("page=2")).toEqual([]);
  });

  it("reads the last value of a flat key", () => {
    expect(strings("purchase_id=a&purchase_id=b")).toEqual(["b"]);
  });

  it("reads every value of a bracketed key in order", () => {
    expect(strings("purchase_id%5B%5D=a&x=1&purchase_id[]=b")).toEqual(["a", "b"]);
  });

  it("leaves out values that are not strings", () => {
    expect(strings("purchase_id")).toEqual([]);
    expect(strings("purchase_id[]&purchase_id[]=a")).toEqual(["a"]);
  });

  it("is null for a flat key mixed with a bracketed one, or a hash", () => {
    expect(strings("purchase_id=a&purchase_id[]=b")).toBeNull();
    expect(strings("purchase_id[x]=a")).toBeNull();
  });
});
