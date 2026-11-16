import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RubySymbol } from "../../cache/marshal.ts";
import { createRailsCache } from "../../cache/rails-cache.ts";
import { resetRailsCacheForTesting } from "../../cache/rails-cache.ts";
import { createMemoryTransport } from "../../cache/transport.ts";
import { MailViewNotPortedError } from "../views.ts";
import { fromEmailAddressWithName, mailerLevel, productLongUrl, type LinkRow, type UserRow } from "./customer-mail-support.ts";

const link = (overrides: Partial<LinkRow> = {}): LinkRow => ({ id: 1, user_id: 2, name: "P", unique_permalink: "abc", custom_permalink: null, support_email: null, json_data: null, ...overrides });
const user = (overrides: Partial<UserRow> = {}): UserRow => ({ id: 2, name: null, username: "seller_one", email: null, unconfirmed_email: null, support_email: null, external_id: "123", ...overrides });

describe("mailerLevel", () => {
  beforeEach(() => resetRailsCacheForTesting(createRailsCache({ transport: createMemoryTransport(), namespace: null })));
  afterEach(() => resetRailsCacheForTesting(undefined));

  it("reads Rails.cache first", async () => {
    const { railsCache } = await import("../../cache/rails-cache.ts");
    await railsCache().write("creator_mailer_level_2", new RubySymbol("level_2"), { expiresIn: 3600 });
    expect(await mailerLevel(2, {})).toBe("level_2");
  });

  it("leaves a seller that is in neither cache to Rails, which sums the sales in Elasticsearch", async () => {
    await expect(mailerLevel(404, { mailerLevel: async () => null })).rejects.toBeInstanceOf(MailViewNotPortedError);
  });
});

describe("fromEmailAddressWithName", () => {
  it("drops colons and newlines and falls back to Gumroad for a blank name", () => {
    expect(fromEmailAddressWithName("A: B\n", "noreply@customers.example.com")).toBe("A B <noreply@customers.example.com>");
    expect(fromEmailAddressWithName(null, "noreply@customers.example.com")).toBe("Gumroad <noreply@customers.example.com>");
    expect(fromEmailAddressWithName("  ", "noreply@customers.example.com")).toBe("Gumroad <noreply@customers.example.com>");
  });

  it("refuses names whose Latin-script and symbol handling is not ported", () => {
    expect(() => fromEmailAddressWithName("Zoë & co", "noreply@customers.example.com")).toThrow(MailViewNotPortedError);
    expect(() => fromEmailAddressWithName(":", "noreply@customers.example.com")).toThrow(MailViewNotPortedError);
  });
});

describe("productLongUrl", () => {
  it("refuses a permalink Rails would percent-escape", () => {
    expect(() => productLongUrl(link({ custom_permalink: "a b" }), user())).toThrow(MailViewNotPortedError);
  });
});
