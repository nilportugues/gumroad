import { beforeEach, describe, expect, it } from "vitest";

import { LinkFlags, Links } from "./link.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { NotPortedError } from "./user.ts";

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  db = fakeDatabase();
});

describe("Links", () => {
  const row = { id: 9n, user_id: 1n, name: "Book", unique_permalink: "abc", filetype: "pdf", banned_at: null } as never;

  it("refuses to create a product before sending anything", async () => {
    await expect(Links.createBang({ user_id: 1n, name: "Book", unique_permalink: "abc" })).rejects.toThrow(NotPortedError);
    expect(db.writes).toEqual([]);
    expect(db.queries).toEqual([]);
  });

  it("refuses an update that changes a column the port does not cover", async () => {
    const link = Links.load(row);
    await expect(Links.update(link, { description: "Renamed", banned_at: new Date(0) })).rejects.toThrow("Link#save changing description is not ported");
    expect(db.queries).toEqual([]);
  });

  it("refuses to destroy a product", async () => {
    await expect(Links.destroy(Links.load(row))).rejects.toThrow(NotPortedError);
    expect(db.writes).toEqual([]);
  });

  it("writes flag conditions with the bit operator", () => {
    expect(LinkFlags.condition("archived").sql).toBe("(`links`.`flags` & 16 = 16)");
  });
});
