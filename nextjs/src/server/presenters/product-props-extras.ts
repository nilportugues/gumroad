// The parts of ProductPresenter::ProductProps#props that read nothing outside the database: covers that are only a URL, public files
// without an upload, the waitlist, the visitor's purchases and the visitor's wishlists. What needs a stored upload's URL, Active
// Storage's signed URLs or `Purchase#purchase_info` still throws NotPortedError, so the page is handed back to Rails.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { followRecaptchaSiteKey } from "../page-props/settings/profile.ts";
import { PurchaseFlags } from "../search/flags.ts";

import type { LinkRow, UserRow } from "./product-reads.ts";

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

const exists = async (from: Prisma.Sql): Promise<boolean> =>
  (await selectRows(Prisma.sql`SELECT 1 FROM ${from} LIMIT 1`)).length > 0;

// `Link#display_asset_previews.as_json` and `main_preview&.guid`. A cover that is an Unsplash URL is a row alone: every other field
// of AssetPreview#as_json comes from an upload's blob or an oEmbed document, so those stay with Rails.
export async function coverProps(
  row: LinkRow,
): Promise<{ covers: Record<string, unknown>[]; main_cover_id: string | null }> {
  const previews = await selectRows<{
    id: bigint;
    guid: string | null;
    oembed: string | null;
    unsplash_url: string | null;
  }>(
    Prisma.sql`SELECT ${column("asset_previews", "id")}, ${column("asset_previews", "guid")}, ${column("asset_previews", "oembed")}, ${column("asset_previews", "unsplash_url")} FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${row.id} AND ${column("asset_previews", "deleted_at")} IS NULL ORDER BY ${column("asset_previews", "position")} ASC, ${column("asset_previews", "created_at")} ASC`,
  );
  if (previews.length === 0) return { covers: [], main_cover_id: null };
  const uploaded = await exists(
    Prisma.sql`${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_type")} = 'AssetPreview' AND ${column("active_storage_attachments", "name")} = 'file' AND ${column("active_storage_attachments", "record_id")} IN (${Prisma.join(previews.map((preview) => preview.id))})`,
  );
  if (uploaded || previews.some((preview) => preview.oembed !== null || !present(preview.unsplash_url)))
    throw new NotPortedError("AssetPreview#as_json for an upload or an oEmbed cover");
  return {
    covers: previews.map((preview) => ({
      url: preview.unsplash_url,
      original_url: preview.unsplash_url,
      thumbnail: null,
      id: preview.guid,
      type: "unsplash",
      filetype: null,
      width: null,
      height: null,
      native_width: null,
      native_height: null,
    })),
    main_cover_id: previews[0]!.guid,
  };
}

// `product.alive_public_files.attached.map { PublicFilePresenter.new(...).props }`: `attached` drops a row with no upload, and the URL
// of one with an upload is a blob URL.
export async function assertNoAttachedPublicFiles(row: LinkRow): Promise<void> {
  const attached = await exists(
    Prisma.sql`${table("public_files")} INNER JOIN ${table("active_storage_attachments")} ON ${column("active_storage_attachments", "record_id")} = ${column("public_files", "id")} AND ${column("active_storage_attachments", "record_type")} = 'PublicFile' AND ${column("active_storage_attachments", "name")} = 'file' WHERE ${column("public_files", "resource_type")} = 'Link' AND ${column("public_files", "resource_id")} = ${row.id} AND ${column("public_files", "deleted_at")} IS NULL`,
  );
  if (attached) throw new NotPortedError("PublicFilePresenter#props");
}

// ProductProps#waitlist_props. The count is for the seller's own view of the page.
export async function waitlistProps(row: LinkRow, seller: UserRow, canEdit: boolean) {
  return {
    recaptcha_site_key: followRecaptchaSiteKey(seller),
    count: canEdit
      ? Number(
          (
            await selectRows<{ count: bigint | number }>(
              Prisma.sql`SELECT COUNT(*) AS count FROM ${table("waitlist_entries")} INNER JOIN ${table("followers")} ON ${column("followers", "id")} = ${column("waitlist_entries", "follower_id")} WHERE ${column("waitlist_entries", "product_id")} = ${row.id} AND ${column("followers", "deleted_at")} IS NULL AND ${column("followers", "confirmed_at")} IS NOT NULL`,
            )
          )[0]!.count,
        )
      : null,
  };
}

type VisitorPurchase = {
  purchase_state: string | null;
  stripe_refunded: boolean | number | null;
  chargeback_date: Date | null;
  flags: bigint | number | null;
};

const has = (purchase: VisitorPurchase, name: Parameters<typeof PurchaseFlags.bit>[0]) =>
  (BigInt(purchase.flags ?? 0) & BigInt(PurchaseFlags.bit(name))) !== 0n;

// The filters of Link#purchase_info_for_product_page up to `bought_purchase`: a purchase that survives them has its
// `Purchase#purchase_info` rendered, which stays in Rails. `rental_expired?` is not read, so a surviving rental is handed back too.
function bought(purchases: VisitorPurchase[], preorder: boolean): boolean {
  return purchases.some((purchase) => {
    const state = purchase.purchase_state ?? "";
    const stateMatches = preorder
      ? ["preorder_authorization_successful", "gift_receiver_purchase_successful"].includes(state)
      : ["successful", "gift_receiver_purchase_successful"].includes(state);
    return (
      stateMatches &&
      !(purchase.stripe_refunded !== null && Number(purchase.stripe_refunded) !== 0) &&
      purchase.chargeback_date === null &&
      !has(purchase, "is_additional_contribution") &&
      !has(purchase, "is_gift_sender_purchase")
    );
  });
}

const VISITOR_COLUMNS = ["purchase_state", "stripe_refunded", "chargeback_date", "flags"] as const;
const visitorColumns = Prisma.join(VISITOR_COLUMNS.map((name) => column("purchases", name)));

// `product.purchase_info_for_product_page(user, browser_guid)` is nil unless a purchase of the signed-in visitor, or one the
// browser's guid made, survives the filters above. The guid is looked at only when the visitor has no purchase of the product at all.
export async function assertNoBoughtPurchase(
  row: LinkRow,
  visitor: { userId: bigint | number | null; browserGuid: string | null },
  preorder: boolean,
): Promise<void> {
  if (visitor.userId === null && visitor.browserGuid === null) return;
  let candidates: VisitorPurchase[] = [];
  if (visitor.userId !== null)
    candidates = await selectRows<VisitorPurchase>(
      Prisma.sql`SELECT ${visitorColumns} FROM ${table("purchases")} WHERE ${column("purchases", "link_id")} = ${row.id} AND ${column("purchases", "purchaser_id")} = ${visitor.userId}`,
    );
  if (candidates.length === 0 && visitor.browserGuid !== null) {
    candidates = (
      await selectRows<VisitorPurchase>(
        Prisma.sql`SELECT ${visitorColumns} FROM ${table("purchases")} WHERE ${column("purchases", "link_id")} = ${row.id} AND ${column("purchases", "browser_guid")} = ${visitor.browserGuid} AND ${column("purchases", "purchaser_id")} IS NULL`,
      )
    ).filter((purchase) => !has(purchase, "is_gift_receiver_purchase"));
  }
  if (bought(candidates, preorder)) throw new NotPortedError("Purchase#purchase_info");
}

// `pundit_user.seller.wishlists.alive.map { WishlistPresenter#listing_props(product:) }`
export async function wishlistProps(row: LinkRow, sellerId: bigint | number) {
  const wishlists = await selectRows<{ id: bigint; name: string | null }>(
    Prisma.sql`SELECT ${column("wishlists", "id")}, ${column("wishlists", "name")} FROM ${table("wishlists")} WHERE ${column("wishlists", "user_id")} = ${sellerId} AND ${column("wishlists", "deleted_at")} IS NULL ORDER BY ${column("wishlists", "id")} ASC`,
  );
  if (wishlists.length === 0) return [];
  const selections = await selectRows<{
    wishlist_id: bigint;
    variant_id: bigint | null;
    recurrence: string | null;
    rent: boolean | number;
    quantity: number;
  }>(
    Prisma.sql`SELECT ${column("wishlist_products", "wishlist_id")}, ${column("wishlist_products", "variant_id")}, ${column("wishlist_products", "recurrence")}, ${column("wishlist_products", "rent")}, ${column("wishlist_products", "quantity")} FROM ${table("wishlist_products")} WHERE ${column("wishlist_products", "wishlist_id")} IN (${Prisma.join(wishlists.map((wishlist) => wishlist.id))}) AND ${column("wishlist_products", "product_id")} = ${row.id} AND ${column("wishlist_products", "deleted_at")} IS NULL ORDER BY ${column("wishlist_products", "id")} ASC`,
  );
  return wishlists.map((wishlist) => ({
    id: encrypt(wishlist.id),
    name: wishlist.name,
    selections_in_wishlist: selections
      .filter((selection) => BigInt(selection.wishlist_id) === BigInt(wishlist.id))
      .map((selection) => ({
        variant_id: selection.variant_id === null ? null : encrypt(selection.variant_id),
        recurrence: selection.recurrence,
        rent: Boolean(Number(selection.rent)),
        quantity: selection.quantity,
      })),
  }));
}
