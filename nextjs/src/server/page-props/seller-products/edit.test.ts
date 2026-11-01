import { afterEach, describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { instantInTimeZoneIso8601 } from "../../models/concerns/rails-time-zone.ts";
import { LinkFlags } from "../../models/link.ts";
import type { LinkRow, UserRow } from "../../presenters/product-reads.ts";
import { setSqlClient } from "../../models/sql.ts";
import { assertEditSupported, editorRevision } from "./edit.ts";
import golden from "./__fixtures__/editor-revision.golden.json" with { type: "json" };

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

  it.each(["product_files", "rich_contents", "variant_categories", "sales", "tags", "asset_previews", "integrations", "existing_files"])("hands back a product with %s", async (blocker) => {
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
