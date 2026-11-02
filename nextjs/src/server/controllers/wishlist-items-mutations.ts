// Wishlists::FollowersController#create, #destroy and #unsubscribe and Wishlists::ProductsController#create and #destroy
// (app/controllers/wishlists/).
import { Prisma, type Wishlist, type WishlistFollower, type WishlistProduct } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { WishlistFollowerDeletable, WishlistFollowers, WishlistProductDeletable, WishlistProducts } from "../models/wishlist-follower.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { LinkFlags } from "../models/link.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { loadSellerContext, roleOwnerFor, requireUser, type SellerContext } from "../policies/seller-context.ts";
import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { requestFormat } from "./rails-params.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import * as Routes from "@/lib/navigation/routes";

const WISHLIST_UPDATED_EMAIL_DELAY_SECONDS = 8 * 3600;
const BUY_ONLY = 0;
const FOUND = 302;
const NO_CONTENT = 204;
const CREATED = 201;
const UNPROCESSABLE_ENTITY = 422;
// `head :created` takes the content type of the request's format; Rails strips it from a 204.
const empty = (status: number): ActionResult => ({ status, body: "", contentType: status === NO_CONTENT ? "" : "application/json", paramsRead: true });

const isHash = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// `Wishlist.find_by_external_id!`, deleted or not.
async function findWishlist(externalId: string): Promise<Wishlist> {
  const id = decrypt(externalId);
  const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`wishlists`.*")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${id} LIMIT 1`);
  if (!row) throw new RoutingError("Not Found");
  return castRow<Wishlist>("Wishlist", row);
}

// authenticate_user!, then Pundit's verdict; a JSON request the policy refuses is answered the way PunditAuthorization answers it.
async function authorized(input: MutationInput, allowed: (context: SellerContext) => boolean | Promise<boolean>): Promise<ActionResult | null> {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null) throw new HandBackToRails("a signed-out wishlist request");
  const sellerContext = await loadSellerContext(input.context);
  if (await allowed(sellerContext)) return null;
  const message = notAllowedMessage(sellerContext);
  return requestFormat(input.request) === "json"
    ? { ...jsonResponse({ success: false, error: message }, 401), rescued: true }
    : { status: FOUND, location: Routes.dashboard_url(input.urlOptions), rescued: true, ...(input.url.searchParams.get("account_switched") ? {} : { flash: { alert: message } }) };
}

const ownerOnly = (context: SellerContext) => roleOwnerFor(requireUser(context));

registerMutations(
  {
    method: "POST",
    pattern: "/wishlists/:wishlist_id/followers",
    formats: ["html", "json", "any"],
    run: async (input) => {
      const wishlist = await findWishlist(input.routeParams.wishlist_id!);
      const denied = await authorized(input, ownerOnly);
      if (denied) return denied;
      const follower = WishlistFollowers.build({ wishlist_id: wishlist.id, follower_user_id: input.context.currentSeller!.id } as Partial<WishlistFollower>);
      if (await WishlistFollowers.save(follower)) return empty(CREATED);
      return jsonResponse({ error: follower.errors.fullMessages()[0] }, UNPROCESSABLE_ENTITY);
    },
  },
  {
    method: "DELETE",
    pattern: "/wishlists/:wishlist_id/followers",
    formats: ["html", "json", "any"],
    run: async (input) => {
      const wishlist = await findWishlist(input.routeParams.wishlist_id!);
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`wishlist_followers`.*")} FROM ${table("wishlist_followers")} WHERE ${column("wishlist_followers", "wishlist_id")} = ${wishlist.id} AND ${column("wishlist_followers", "deleted_at")} IS NULL AND ${column("wishlist_followers", "follower_user_id")} = ${input.context.currentSeller?.id ?? 0} LIMIT 1`,
      );
      // `e404 if wishlist_follower.blank?` runs before the policy.
      if (!row) throw new RoutingError("Not Found");
      const follower = WishlistFollowers.load(castRow<WishlistFollower>("WishlistFollower", row));
      const denied = await authorized(input, ownerOnly);
      if (denied) return denied;
      await WishlistFollowerDeletable.markDeletedBang(follower);
      return empty(NO_CONTENT);
    },
  },
  {
    method: "POST",
    pattern: "/wishlists/:wishlist_id/products",
    formats: ["html", "json", "any"],
    run: async (input) => {
      if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null) throw new HandBackToRails("a signed-out wishlist request");
      const id = decrypt(input.routeParams.wishlist_id!);
      // `current_seller.wishlists.find_by_external_id!`
      const [wishlistRow] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`wishlists`.*")} FROM ${table("wishlists")} WHERE ${column("wishlists", "user_id")} = ${input.context.currentSeller.id} AND ${column("wishlists", "id")} = ${id} LIMIT 1`);
      if (!wishlistRow) throw new RoutingError("Not Found");
      const wishlist = castRow<Wishlist>("Wishlist", wishlistRow);
      const denied = await authorized(input, ownerOnly);
      if (denied) return denied;

      // `permitted_attributes(WishlistProduct)`
      const params = input.params;
      let attributes = params.wishlist_product;
      if (!("wishlist_product" in params)) {
        const contentType = (input.request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (contentType !== "application/json") throw new HandBackToRails("a wishlist product without its parameter");
        attributes = Object.fromEntries(Object.entries(params).filter(([key]) => ["id", "wishlist_id", "product_id", "variant_id", "recurrence", "quantity", "rent", "created_at", "updated_at", "deleted_at"].includes(key)));
      }
      if (!isHash(attributes) || Object.keys(attributes).length === 0) throw new HandBackToRails("a wishlist_product parameter that is not a populated hash");
      const { product_id: productId, option_id: optionId, recurrence, quantity, rent } = attributes;
      if (typeof productId !== "string") throw new HandBackToRails("a non-string product_id");
      // Variants, recurring billing and non-default quantity or rent decide validations this port does not run.
      if ((optionId !== undefined && optionId !== null && optionId !== "") || (recurrence !== undefined && recurrence !== null && recurrence !== "") || (quantity !== undefined && String(quantity) !== "1") || (rent !== undefined && !["false", "0", false, "f"].includes(rent as never))) {
        throw new HandBackToRails("a wishlist product with an option, recurrence, quantity or rent");
      }
      const productNumericId = decrypt(productId);
      const [product] = productNumericId === null ? [] : await selectRows<{ id: bigint; flags: bigint; purchase_type: number | null }>(Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productNumericId} LIMIT 1`);
      if (!product) throw new RoutingError("Not Found");
      const recurring = LinkFlags.isSet(product.flags as never, "is_recurring_billing");
      const versioned = LinkFlags.isSet(product.flags as never, "skus_enabled") || LinkFlags.isSet(product.flags as never, "quantity_enabled");
      const [variant] = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${product.id} LIMIT 1`,
      );
      if (recurring || versioned || variant || (product.purchase_type ?? BUY_ONLY) !== BUY_ONLY) throw new HandBackToRails("a product with versions, recurring billing, rent or quantity");

      const [existing] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`wishlist_products`.*")} FROM ${table("wishlist_products")} WHERE ${column("wishlist_products", "wishlist_id")} = ${wishlist.id} AND ${column("wishlist_products", "deleted_at")} IS NULL AND ${column("wishlist_products", "product_id")} = ${product.id} AND ${column("wishlist_products", "variant_id")} IS NULL AND ${column("wishlist_products", "recurrence")} IS NULL LIMIT 1`,
      );
      let record: ModelRecord<WishlistProduct>;
      if (existing) {
        record = WishlistProducts.load(castRow<WishlistProduct>("WishlistProduct", existing));
        // `update({})` of an unchanged record saves nothing.
        if (record.hasChangesToSave()) await WishlistProducts.save(record);
      } else {
        record = WishlistProducts.build({ wishlist_id: wishlist.id, product_id: product.id, variant_id: null, recurrence: null, quantity: 1, rent: false } as Partial<WishlistProduct>);
        if (!(await WishlistProducts.save(record))) return jsonResponse({ error: record.errors.fullMessages()[0] }, UNPROCESSABLE_ENTITY);
      }
      const [follower] = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table("wishlist_followers")} WHERE ${column("wishlist_followers", "wishlist_id")} = ${wishlist.id} AND ${column("wishlist_followers", "deleted_at")} IS NULL LIMIT 1`);
      if (follower) {
        const rows = await selectRows<{ id: bigint }>(
          Prisma.sql`SELECT ${column("wishlist_products", "id")} FROM ${table("wishlist_products")} WHERE ${column("wishlist_products", "wishlist_id")} = ${wishlist.id} AND ${column("wishlist_products", "deleted_at")} IS NULL${wishlist.followers_last_contacted_at ? Prisma.sql` AND (created_at > ${wishlist.followers_last_contacted_at})` : Prisma.empty}`,
        );
        await performAsync("SendWishlistUpdatedEmailsJob", [wishlist.id, rows.map((row) => row.id)] as never, { delaySeconds: WISHLIST_UPDATED_EMAIL_DELAY_SECONDS });
      }
      return empty(CREATED);
    },
  },
  {
    method: "DELETE",
    pattern: "/wishlists/:wishlist_id/products/:id",
    formats: ["html", "json", "any"],
    run: async (input) => {
      if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null) throw new HandBackToRails("a signed-out wishlist request");
      const id = decrypt(input.routeParams.id!);
      // `WishlistProduct.alive.find_by_external_id!`
      const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`wishlist_products`.*")} FROM ${table("wishlist_products")} WHERE ${column("wishlist_products", "deleted_at")} IS NULL AND ${column("wishlist_products", "id")} = ${id} LIMIT 1`);
      if (!row) throw new RoutingError("Not Found");
      const record = WishlistProducts.load(castRow<WishlistProduct>("WishlistProduct", row));
      const [wishlist] = await selectRows<{ user_id: bigint | null }>(Prisma.sql`SELECT ${column("wishlists", "user_id")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${record.get("wishlist_id")} LIMIT 1`);
      const denied = await authorized(input, (context) => ownerOnly(context) && wishlist?.user_id === requireUser(context).user.id);
      if (denied) return denied;
      await WishlistProductDeletable.markDeletedBang(record);
      return empty(NO_CONTENT);
    },
  },
);
