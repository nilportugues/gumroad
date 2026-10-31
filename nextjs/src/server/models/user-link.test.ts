import { beforeEach, describe, expect, it } from "vitest";

import { LinkFlags, Links } from "./link";
import { fakeDatabase } from "./runtime/testing";

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  db = fakeDatabase();
});

const versions = () => db.committed.filter((w) => w.model === "version").map((w) => w.data!);

describe("Links", () => {
  const attributes = { user_id: 1n, name: "Book", unique_permalink: "abc", filetype: "PDF", description: 'a<!--?xml version="1.0"?-->b' };

  it("downcases the filetype and strips pasted XML before saving", async () => {
    const link = await Links.createBang(attributes);
    expect(link.get("filetype")).toBe("pdf");
    expect(link.get("description")).toBe("ab");
    expect(versions().map((v) => v.event)).toEqual(["create"]);
  });

  it("explains which custom permalink rule a value broke", async () => {
    const link = Links.build({ ...attributes, custom_permalink: "no spaces", discover_fee_per_thousand: 200 });
    expect(await Links.save(link)).toBe(false);
    expect(link.errors.fullMessages()).toEqual([
      "Custom permalink can only contain letters, numbers, dashes, and underscores",
      "Discover fee per thousand must be between 30% and 100%",
    ]);
  });

  it("writes flag conditions with the bit operator", () => {
    expect(LinkFlags.condition("archived").sql).toBe("(`links`.`flags` & 16 = 16)");
  });
});
