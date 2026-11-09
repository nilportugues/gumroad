import { afterEach, describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { instantInTimeZoneIso8601 } from "../../models/concerns/rails-time-zone.ts";
import { LinkFlags } from "../../models/link.ts";
import type { LinkRow, UserRow } from "../../presenters/product-reads.ts";
import { setSqlClient } from "../../models/sql.ts";
import { assertEditSupported, editorRevision, otherProductRefundPolicies, productTagNames } from "./edit.ts";
import golden from "./__fixtures__/editor-revision.golden.json" with { type: "json" };

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws12f-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const product = (overrides: Partial<LinkRow> = {}): LinkRow =>
  ({ id: 5n, user_id: 9n, native_type: "digital", flags: 0n, max_purchase_count: null, default_offer_code_id: null, subscription_duration: null, free_trial_duration_amount: null, free_trial_duration_unit: null, price_currency_type: "usd", ...overrides }) as LinkRow;
const seller = { id: 9n } as UserRow;

function blockedBy(...blockers: string[]) {
  setSqlClient(() => ({ $queryRaw: async () => blockers.map((blocker) => ({ blocker })), $executeRaw: async () => 0 }) as never);
}

afterEach(() => setSqlClient(undefined as never));

describe("editorRevision", () => {
  for (const [name, example] of Object.entries(golden.cases)) {
    it(`matches Product::EditorRevision.current for ${name}`, () => {
      expect(editorRevision(product({ id: BigInt(example.id), flags: BigInt(example.flags) }), golden.secret)).toBe(example.digest);
    });
  }
});

describe("instantInTimeZoneIso8601", () => {
  it("formats an instant with the zone's offset", () => {
    expect(instantInTimeZoneIso8601("Tokyo", new Date("2026-11-08T00:10:30.700Z"))).toBe("2026-11-08T09:10:30+09:00");
    expect(instantInTimeZoneIso8601("Pacific Time (US & Canada)", new Date("2026-11-08T16:10:30Z"))).toBe("2026-11-08T08:10:30-08:00");
    expect(instantInTimeZoneIso8601("UTC", new Date("2026-06-01T12:00:00Z"))).toBe("2026-06-01T12:00:00Z");
  });
});

describe("assertEditSupported", () => {
  it("accepts a plain product", async () => {
    blockedBy();
    await expect(assertEditSupported(product(), seller, 9n)).resolves.toBeUndefined();
  });

  it("hands back a product edited by someone other than its seller", async () => {
    blockedBy();
    await expect(assertEditSupported(product(), seller, 10n)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each(["product_files", "rich_contents", "variant_categories", "sales", "asset_previews", "integrations", "existing_files"])("hands back a product with %s", async (blocker) => {
    blockedBy(blocker);
    await expect(assertEditSupported(product(), seller, 9n)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each(["membership", "physical", "call", "coffee", "commission", "bundle"])("hands back a %s product", async (nativeType) => {
    blockedBy();
    await expect(assertEditSupported(product({ native_type: nativeType }), seller, 9n)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it.each(["is_recurring_billing", "is_tiered_membership", "is_physical", "is_in_preorder_state", "free_trial_enabled", "is_collab"] as const)("hands back a product with %s set", async (flag) => {
    blockedBy();
    const flags = LinkFlags.set(0n, flag, true);
    await expect(assertEditSupported(product({ flags }), seller, 9n)).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a product with a purchase limit or a default offer code", async () => {
    blockedBy();
    await expect(assertEditSupported(product({ max_purchase_count: 3 }), seller, 9n)).rejects.toBeInstanceOf(HandBackToRails);
    await expect(assertEditSupported(product({ default_offer_code_id: 1n }), seller, 9n)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("productTagNames", () => {
  it("reads the tag names in tag_id order", async () => {
    let sql = "";
    setSqlClient(() => ({ $queryRaw: async (query: { sql: string }) => ((sql = query.sql), [{ name: "art" }, { name: "music" }]), $executeRaw: async () => 0 }) as never);
    await expect(productTagNames(5n)).resolves.toEqual(["art", "music"]);
    expect(sql).toMatch(/ORDER BY `product_taggings`\.`tag_id` ASC/);
  });
});

describe("otherProductRefundPolicies", () => {
  it("shapes ProductRefundPolicy#as_json from the seller's other visible, unarchived products", async () => {
    let sql = "";
    setSqlClient(() => ({ $queryRaw: async (query: { sql: string }) => ((sql = query.sql), [{ id: 3n, fine_print: "Fine", max_refund_period_in_days: 14, product_name: "Other" }]), $executeRaw: async () => 0 }) as never);
    const [policy] = await otherProductRefundPolicies(5n, 9n);
    expect(policy).toEqual({ fine_print: "Fine", id: expect.any(String), max_refund_period_in_days: 14, product_name: "Other", title: "14-day money back guarantee" });
    expect(sql).toMatch(/`updated_at` DESC/);
    expect(sql).toMatch(/`deleted_at` IS NULL/);
  });
});
