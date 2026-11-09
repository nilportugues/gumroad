import { afterEach, describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { setSqlClient } from "../../models/sql.ts";
import type { LinkRow, UserRow } from "../../presenters/product-reads.ts";

import { assertBundleEditSupported, bundleBlockers } from "./edit.ts";

// flag_shih_tzu positions are 1-based (app/models/link.rb): is_recurring_billing 2, is_bundle 26.
const IS_RECURRING_BILLING = 1n << 1n;
const IS_BUNDLE = 1n << 25n;

const bundle = (overrides: Partial<LinkRow> = {}): LinkRow =>
  ({
    id: 5n,
    user_id: 9n,
    native_type: "bundle",
    flags: IS_BUNDLE,
    default_offer_code_id: null,
    draft: false,
    purchase_disabled_at: null,
    deleted_at: null,
    ...overrides,
  }) as LinkRow;
const seller = { id: 9n } as UserRow;

function probeRows(...blockers: string[]) {
  setSqlClient(
    () => ({ $queryRaw: async () => blockers.map((blocker) => ({ blocker })), $executeRaw: async () => 0 }) as never,
  );
}

afterEach(() => setSqlClient(undefined as never));

describe("bundleBlockers", () => {
  it("is empty for a plain published bundle", async () => {
    probeRows();
    expect(await bundleBlockers(bundle(), seller)).toEqual([]);
  });

  it("ignores rows the bundle editors never read", async () => {
    probeRows("rich_contents", "integrations", "custom_html");
    expect(await bundleBlockers(bundle(), seller, "product")).toEqual([]);
  });

  it("keeps a custom landing page as a blocker on the share tab only", async () => {
    probeRows("custom_html");
    expect(await bundleBlockers(bundle(), seller, "share")).toEqual(["custom_html"]);
  });

  it("blocks on a row the port does not model", async () => {
    probeRows("product_files");
    expect(await bundleBlockers(bundle(), seller)).toContain("product_files");
  });

  it("blocks a product that is not yet a bundle", async () => {
    probeRows();
    expect(await bundleBlockers(bundle({ flags: 0n, native_type: "digital" }), seller)).toEqual(["not_a_bundle"]);
  });

  it("blocks recurring billing and a default offer code", async () => {
    probeRows();
    expect(
      await bundleBlockers(bundle({ flags: IS_BUNDLE | IS_RECURRING_BILLING, default_offer_code_id: 3n }), seller),
    ).toEqual(["is_recurring_billing", "default_offer_code"]);
  });
});

describe("assertBundleEditSupported", () => {
  it("hands a collaborator's session back to Rails", async () => {
    probeRows();
    await expect(assertBundleEditSupported(bundle(), seller, 10n, "product")).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands an unpublished bundle's share tab back to Rails (ensure_published)", async () => {
    probeRows();
    await expect(assertBundleEditSupported(bundle({ draft: true }), seller, 9n, "share")).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    await expect(assertBundleEditSupported(bundle({ draft: true }), seller, 9n, "product")).resolves.toBeUndefined();
  });

  it("hands back a bundle with blocking rows", async () => {
    probeRows("offer_codes");
    await expect(assertBundleEditSupported(bundle(), seller, 9n, "product")).rejects.toBeInstanceOf(HandBackToRails);
  });
});
