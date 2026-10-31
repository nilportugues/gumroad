import { beforeEach, describe, expect, it } from "vitest";

import { LinkFlags, Links } from "./link";
import { fakeDatabase } from "./runtime/testing";
import { UserFlags, Users } from "./user";

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  db = fakeDatabase();
});

const versions = () => db.committed.filter((w) => w.model === "version").map((w) => w.data!);

describe("Users", () => {
  it("enables the default flags on create and versions the row without skipped secrets", async () => {
    const user = await Users.createBang({ email: "seller@example.com", encrypted_password: "hash", notification_endpoint: "example.com/ping" });

    for (const flag of ["enable_payment_email", "two_factor_authentication_enabled", "tipping_enabled", "product_page_storefront_enabled"] as const) {
      expect(UserFlags.isSet(user.get("flags"), flag)).toBe(true);
    }
    expect(user.get("notification_endpoint")).toBe("http://example.com/ping");
    expect(versions()).toHaveLength(1);
    expect(versions()[0]!.object_changes).not.toContain("encrypted_password");
    expect(versions()[0]!.item_type).toBe("User");
  });

  it("leaves two-factor off when the caller skips it", async () => {
    const user = Users.build({ email: "seller@example.com" });
    user.ivars.skip_enabling_two_factor_authentication = true;
    await Users.saveBang(user);
    expect(UserFlags.isSet(user.get("flags"), "two_factor_authentication_enabled")).toBe(false);
  });

  it("rejects an over-long name with the custom message", async () => {
    const user = Users.build({ email: "seller@example.com", name: "x".repeat(101) });
    expect(await Users.save(user)).toBe(false);
    expect(user.errors.fullMessages()).toEqual(["Name Your name is too long. Please try again with a shorter one."]);
  });
});

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
