import { afterEach, describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { instantInTimeZoneIso8601 } from "../../models/concerns/rails-time-zone.ts";
import { LinkFlags } from "../../models/link.ts";
import type { LinkRow, UserRow } from "../../presenters/product-reads.ts";
import { setSqlClient } from "../../models/sql.ts";
import { assertEditSupported, editBlockers, editorRevision, otherProductRefundPolicies, productTagNames } from "./edit.ts";
import { recoverableHiddenVariantRichContent, variantProps, versionStamps, type VersionRows } from "./edit-variants.ts";
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

describe("editorRevision with versions", () => {
  for (const [name, example] of Object.entries(golden.cases)) {
    const recorded = example as { variant_rows?: Record<string, unknown>[]; category_rows?: Record<string, unknown>[]; fingerprint: string };
    if (!recorded.variant_rows) continue;
    it(`matches Product::EditorRevision.current for ${name}`, () => {
      const versions = { variants: recorded.variant_rows!, categories: recorded.category_rows! };
      expect(editorRevision(product({ id: BigInt(example.id), flags: BigInt(example.flags) }), golden.secret, versions)).toBe(example.digest);
    });
  }

  // Hand-computed from Product::EditorRevision#row_digests: SHA256 over the non-timestamp columns joined by "\x1f", first 16 hex.
  const deluxe = { id: 7, variant_category_id: 3, price_difference_cents: 500, name: "Deluxe", max_purchase_count: 10, deleted_at: null, type: "Variant", link_id: null, custom_sku: null, flags: 0, description: "With extras", position_in_category: null, customizable_price: null, subscription_price_change_effective_date: null, subscription_price_change_message: null, duration_in_minutes: null, sales_count_for_inventory_cache: 4 };
  const edition = { id: 3, link_id: 2, deleted_at: null, title: "Edition", flags: 0 };

  it("digests every non-timestamp column of the versions and their categories", () => {
    expect(versionStamps({ variants: [deluxe], categories: [edition] })).toEqual({ variants: [[7, "332ff3d6fadd5e97"]], variant_categories: [[3, "0aa4dc72cbeccc5f"]] });
  });

  it("moves the token when a sale changes a version's inventory counter", () => {
    const base: VersionRows = { variants: [deluxe], categories: [edition] };
    const sold: VersionRows = { variants: [{ ...deluxe, sales_count_for_inventory_cache: 5 }], categories: [edition] };
    expect(editorRevision(product(), "k", sold)).not.toBe(editorRevision(product(), "k", base));
    expect(editorRevision(product(), "k", base)).not.toBe(editorRevision(product(), "k"));
  });
});

describe("variantProps", () => {
  const row = (overrides: Record<string, unknown>) => ({ id: 7, type: "Variant", name: "Deluxe", description: "With extras", price_difference_cents: 500, max_purchase_count: null, sales_count_for_inventory_cache: 4, created_at: new Date("2026-01-02T00:00:00Z"), updated_at: new Date("2026-01-03T00:00:00Z"), ...overrides });

  function answer(responses: { rich?: unknown[]; prices?: unknown[] }) {
    setSqlClient(() => ({ $queryRaw: async (query: { sql: string }) => (query.sql.includes("FROM `rich_contents`") ? (responses.rich ?? []) : (responses.prices ?? [])), $executeRaw: async () => 0 }) as never);
  }

  it("serves each version in created_at order with its price difference, inventory and the newer of its row and price stamps", async () => {
    answer({ prices: [{ variant_id: 7, updated_at: new Date("2026-02-01T10:20:30Z") }] });
    const versions = await variantProps({ categories: [], variants: [row({ id: 8, name: null, description: null, price_difference_cents: null, created_at: new Date("2026-01-05T00:00:00Z") }), row({ max_purchase_count: 10 })] }, false);
    expect(versions.map((version) => version.name)).toEqual(["Deluxe", ""]);
    expect(versions[0]).toMatchObject({ description: "With extras", updated_at: "2026-02-01T10:20:30.000Z", max_purchase_count: 10, sales_count_for_inventory: 4, price_difference_cents: 500, has_files: false, active_subscribers_count: 0, rich_content: [], loaded_integrations: { circle: false, discord: false, zoom: false, google_calendar: false } });
    expect(versions[1]).toMatchObject({ description: "", sales_count_for_inventory: 0, price_difference_cents: null, updated_at: "2026-01-03T00:00:00.000Z" });
  });

  it("reports no inventory sold when the purchase limit is zero", async () => {
    answer({});
    const [version] = await variantProps({ categories: [], variants: [row({ max_purchase_count: 0 })] }, false);
    expect(version!.sales_count_for_inventory).toBe(0);
  });

  it("skips rows that are not plain versions", async () => {
    answer({});
    await expect(variantProps({ categories: [], variants: [row({ type: "Sku" })] }, false)).resolves.toEqual([]);
  });

  it("maps a version's pages as RichContents#rich_content_json and hides them when the product shares its content", async () => {
    const page = { id: 11n, entity_id: 7n, title: "Welcome", description: [{ type: "paragraph" }], updated_at: new Date("2026-01-04T00:00:00.123Z") };
    answer({ rich: [page] });
    const [version] = await variantProps({ categories: [], variants: [row({})] }, false);
    expect(version!.rich_content).toEqual([{ id: expect.any(String), page_id: expect.any(String), title: "Welcome", variant_id: version!.id, description: { type: "doc", content: [{ type: "paragraph" }] }, updated_at: "2026-01-04T00:00:00.123Z" }]);
    const [content] = version!.rich_content as { id: string; page_id: string }[];
    expect(content!.id).toBe(content!.page_id);
    const [shared] = await variantProps({ categories: [], variants: [row({})] }, true);
    expect(shared!.rich_content).toEqual([]);
  });
});

describe("recoverableHiddenVariantRichContent", () => {
  const answerPages = (pages: { title: string | null; description: unknown }[]) => setSqlClient(() => ({ $queryRaw: async () => pages, $executeRaw: async () => 0 }) as never);
  const blank = [{ type: "paragraph" }];
  const hello = [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }];

  it("is true when a version holds a page with a body", async () => {
    answerPages([{ title: null, description: blank }, { title: null, description: hello }]);
    await expect(recoverableHiddenVariantRichContent(5n)).resolves.toBe(true);
  });

  it("is true for a titled page with a blank body", async () => {
    answerPages([{ title: "Welcome", description: blank }]);
    await expect(recoverableHiddenVariantRichContent(5n)).resolves.toBe(true);
  });

  it("is false when the versions hold no pages or only blank ones", async () => {
    answerPages([]);
    await expect(recoverableHiddenVariantRichContent(5n)).resolves.toBe(false);
    answerPages([{ title: null, description: blank }]);
    await expect(recoverableHiddenVariantRichContent(5n)).resolves.toBe(false);
  });

  it("no longer hands back a product that shares its content while a version holds pages", async () => {
    blockedBy();
    await expect(assertEditSupported(product({ flags: LinkFlags.set(0n, "has_same_rich_content_for_all_variants", true) }), seller, 9n)).resolves.toBeUndefined();
  });

  it("serves the versions' pages when they are recoverable and hides them otherwise", async () => {
    const page = { id: 11n, entity_id: 7n, title: null, description: hello, updated_at: new Date("2026-01-04T00:00:00Z") };
    const version = { id: 7, type: "Variant", name: "Standard", description: null, price_difference_cents: 0, max_purchase_count: null, sales_count_for_inventory_cache: 0, created_at: new Date("2026-01-02T00:00:00Z"), updated_at: new Date("2026-01-03T00:00:00Z") };
    setSqlClient(() => ({ $queryRaw: async (query: { sql: string }) => (query.sql.includes("FROM `rich_contents`") ? [page] : []), $executeRaw: async () => 0 }) as never);
    const [shown] = await variantProps({ categories: [], variants: [version] }, false);
    const [hidden] = await variantProps({ categories: [], variants: [version] }, true);
    expect(shown!.rich_content).toHaveLength(1);
    expect(hidden!.rich_content).toEqual([]);
  });
});

describe("skus", () => {
  it("does not probe for SKU rows", async () => {
    let sql = "";
    setSqlClient(() => ({ $queryRaw: async (query: { sql: string }) => ((sql = query.sql), []), $executeRaw: async () => 0 }) as never);
    await editBlockers(product(), seller);
    expect(sql).not.toMatch(/`base_variants`\.`link_id`/);
  });

  it("accepts a product with skus_enabled set: edit_props reads neither the flag nor the SKU rows", async () => {
    blockedBy();
    await expect(assertEditSupported(product({ flags: LinkFlags.set(0n, "skus_enabled", true) }), seller, 9n)).resolves.toBeUndefined();
  });
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

  it.each(["product_files", "rich_contents", "variant_integrations", "sales", "asset_previews", "integrations", "existing_files"])("hands back a product with %s", async (blocker) => {
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
