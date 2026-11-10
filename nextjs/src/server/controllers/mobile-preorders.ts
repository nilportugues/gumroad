// Port of app/controllers/api/mobile/preorders_controller.rb#preorder_attributes.
//
// Served here: the 404 for an id that is not an `authorization_successful` or `charge_successful` preorder, and the payload of an
// `authorization_successful` preorder whose product has no asset previews and whose seller has no posts, so `product_updates_data`
// is []. A charged preorder goes to Rails whole, because it serializes the charge purchase's url redirect
// (UrlRedirect#product_json_data), which is not ported.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { profileUrl } from "../page-props/buyer/users.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import { thumbnailUrlsByProduct } from "../presenters/mobile-serializer-reads.ts";
import { jsonTime, linkAsJsonMobile } from "../presenters/mobile-serializers.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails } from "./application-controller.ts";
import { fetchError, registerMobile, renderJson, type MobileInput } from "./mobile-api.ts";

const PREORDER_STATES = ["authorization_successful", "charge_successful"];

type PreorderRow = { id: bigint; state: string; preorder_link_id: bigint | null };

// Preorder.authorization_successful_or_charge_successful.find_by_external_id
async function findPreorder(externalId: unknown): Promise<PreorderRow | null> {
  const id = typeof externalId === "string" ? decrypt(externalId) : null;
  if (id === null) return null;
  const [row] = await selectRows<PreorderRow>(
    Prisma.sql`SELECT ${column("preorders", "id")}, ${column("preorders", "state")}, ${column("preorders", "preorder_link_id")} FROM ${table("preorders")} WHERE ${column("preorders", "id")} = ${id} AND ${column("preorders", "state")} IN (${Prisma.join(PREORDER_STATES)}) LIMIT 1`,
  );
  return row ?? null;
}

// product_updates_data maps the posts of the purchase's product, so any post of the seller or the product is Rails'.
async function sellerHasPosts(sellerId: bigint, productId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${sellerId} OR ${column("installments", "link_id")} = ${productId} LIMIT 1`,
  );
  return rows.length > 0;
}

// Preorder#mobile_json_data for the authorization purchase of an authorization_successful preorder
async function preorderAttributes(input: MobileInput) {
  const preorder = await findPreorder(input.params.id);
  if (preorder === null) return fetchError("Could not find preorder");
  if (preorder.state !== "authorization_successful") throw new HandBackToRails("a charged preorder");
  if (preorder.preorder_link_id === null) throw new NotPortedError("a preorder without a preorder link");

  // purchases.first is the authorization; charge_purchase_successful? reads purchases.last
  const purchases = await selectRows<{ id: bigint; purchase_state: string | null }>(
    Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "purchase_state")} FROM ${table("purchases")} WHERE ${column("purchases", "preorder_id")} = ${preorder.id} ORDER BY ${column("purchases", "id")} ASC`,
  );
  const first = purchases[0];
  if (first === undefined) throw new NotPortedError("a preorder without purchases");
  if (purchases[purchases.length - 1]!.purchase_state === "successful")
    throw new HandBackToRails("a preorder whose last purchase is successful");

  const [preorderLink] = await selectRows<{ link_id: bigint | null; release_at: Date | null }>(
    Prisma.sql`SELECT ${column("preorder_links", "link_id")}, ${column("preorder_links", "release_at")} FROM ${table("preorder_links")} WHERE ${column("preorder_links", "id")} = ${preorder.preorder_link_id} LIMIT 1`,
  );
  if (preorderLink?.link_id == null) throw new NotPortedError("a preorder link without a product");
  const link = await db.link.findUnique({ where: { id: preorderLink.link_id } });
  const creator = link?.user_id == null ? null : await db.user.findUnique({ where: { id: link.user_id } });
  const purchase = await db.purchase.findUnique({ where: { id: BigInt(first.id) } });
  if (!link || !creator || !purchase)
    throw new NotPortedError("a preorder whose product, creator or purchase row is missing");
  if (await sellerHasPosts(creator.id, link.id))
    throw new NotPortedError("Purchase#update_json_data_for_mobile for a seller with posts");
  if (creator.username === null || creator.username.trim() === "")
    throw new NotPortedError("User#profile_url for a creator without a username");

  const previews = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${link.id} AND ${column("asset_previews", "deleted_at")} IS NULL LIMIT 1`,
  );
  const thumbnails = await thumbnailUrlsByProduct([link.id]);
  const purchaser =
    purchase.purchaser_id === null ? null : await db.user.findUnique({ where: { id: purchase.purchaser_id } });

  const json: Record<string, unknown> = linkAsJsonMobile({
    link,
    creator,
    creatorAvatarUrl: await avatarUrl(creator),
    creatorProfileUrl: profileUrl(creator),
    thumbnailOrCoverUrl: thumbnails.get(link.id) ?? null,
    hasAlivePreviews: previews.length > 0,
  });
  json.purchase_id = encrypt(purchase.id);
  json.purchased_at = jsonTime(purchase.created_at);
  if (purchaser) json.user_id = purchaser.external_id;
  json.product_updates_data = [];
  json.is_archived = PurchaseFlags.isSet(purchase.flags, "is_archived");
  json.preorder_data = { external_id: encrypt(preorder.id), release_at: jsonTime(preorderLink.release_at) };
  return renderJson({ success: true, product: json });
}

registerMobile({
  method: "GET",
  pattern: "/mobile/preorders/preorder_attributes/:id",
  scopes: null,
  run: preorderAttributes,
});
