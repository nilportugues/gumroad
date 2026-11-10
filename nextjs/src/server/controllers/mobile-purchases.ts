// Port of app/controllers/api/mobile/purchases_controller.rb and app/controllers/api/mobile/sales_controller.rb (index, show, options).
//
// Served here: the unconfirmed-account 403, the 404 for a purchase that is not the caller's, the empty lists, sales#index rows
// whose Purchase#as_json(creator_app_api: true) is ported (presenters/mobile-serializers.ts: USD, no recurrence), and
// purchase_attributes of a plain purchase (no url redirect, preorder, subscription, refund or review) whose seller and product have no
// post. Everything else (the rest of purchase_attributes, a non-empty library page, sales#show, every write: archive, unarchive,
// destroy, sales#update) goes to Rails whole, because UrlRedirect#product_json_data, Preorder#mobile_json_data and the posts of
// the product-updates preloader are not ported.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { preloadProductUpdatesData } from "../models/purchase-product-updates.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { profileUrl } from "../page-props/buyer/users.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import { creatorAppPurchasesJson, thumbnailUrlsByProduct } from "../presenters/mobile-serializer-reads.ts";
import { purchaseJsonDataForMobile } from "../presenters/mobile-serializers.ts";
import { linkOptions } from "../presenters/product-props.ts";
import { findLink } from "../presenters/product-reads.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { HandBackToRails } from "./application-controller.ts";
import { fetchError, FORBIDDEN, registerMobile, renderJson, type MobileAuth, type MobileInput } from "./mobile-api.ts";

const MOBILE_API_SCOPES = ["mobile_api"];
const DEFAULT_SEARCH_RESULTS_SIZE = 10;
const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 100;
const SALES_PER_PAGE = 20;
// Purchase::NON_GIFT_SUCCESS_STATES
const NON_GIFT_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged"];
const FIRST_PAGE = 1;
const DIGITS = /^\d{1,9}$/u;

// Api::Mobile::PurchasesController#library_owner
const libraryOwner = (auth: MobileAuth | null) => auth!.impersonated ?? auth!.accountHolder;

// `(params[name] || default).to_i` for the shapes whose to_i is plain digits; anything else is Ruby's.
function integerParam(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && DIGITS.test(value)) return Number(value);
  throw new HandBackToRails(`a ${name} Node does not cast`);
}

// before_action :require_confirmed_user. A before_action's render halts the chain, so the after_actions do not run.
function requireConfirmedUser(auth: MobileAuth | null) {
  if (libraryOwner(auth).confirmed_at != null) return null;
  return fetchError("Please confirm your email address before you can see your purchases.", FORBIDDEN);
}

// PagyPresenter#metadata for a collection with no rows.
const emptyPagination = (items: number) => ({
  count: 0,
  items,
  page: FIRST_PAGE,
  pages: 1,
  prev: null,
  next: null,
  last: 1,
});

async function buyerHasPurchases(buyerId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "purchaser_id")} = ${buyerId} LIMIT 1`,
  );
  return rows.length > 0;
}

// A buyer with no purchases row at all has an empty listing whatever for_mobile_listing, q, seller, archived and purchase_ids filter.
async function emptyLibrary(auth: MobileAuth | null): Promise<boolean> {
  return !(await buyerHasPurchases(libraryOwner(auth).id));
}

async function index(input: MobileInput, auth: MobileAuth | null) {
  const refused = requireConfirmedUser(auth);
  if (refused) return refused;
  const page = integerParam(input.params.page, FIRST_PAGE, "page");
  const perPage = Math.min(
    Math.max(integerParam(input.params.per_page, DEFAULT_PER_PAGE, "per_page"), 1),
    MAX_PER_PAGE,
  );
  if (page !== FIRST_PAGE || !(await emptyLibrary(auth)))
    throw new HandBackToRails("a purchase listing with rows or beyond the first page");
  return renderJson({
    success: true,
    products: [],
    user_id: libraryOwner(auth).external_id,
    meta: { pagination: emptyPagination(perPage) },
  });
}

async function search(input: MobileInput, auth: MobileAuth | null) {
  const refused = requireConfirmedUser(auth);
  if (refused) return refused;
  for (const name of ["q", "seller", "archived", "purchase_ids", "order"]) {
    const value = input.params[name];
    if (value !== undefined && value !== null && typeof value !== "string")
      throw new HandBackToRails(`a ${name} that is not a string`);
  }
  const page = integerParam(input.params.page, FIRST_PAGE, "page");
  const items = integerParam(input.params.items, DEFAULT_SEARCH_RESULTS_SIZE, "items");
  if (page !== FIRST_PAGE || items < 1 || !(await emptyLibrary(auth)))
    throw new HandBackToRails("a purchase search with rows or beyond the first page");
  return renderJson({
    success: true,
    user_id: libraryOwner(auth).external_id,
    purchases: [],
    sellers: [],
    meta: { pagination: emptyPagination(items) },
  });
}

// before_action :fetch_purchase for purchase_attributes, archive, unarchive and destroy. A purchase that is the caller's goes to Rails:
// whether it is `successful_and_not_reversed?` or has a subscription, and its JSON, are not ported.
const purchaseAction = (verb: string) => async (input: MobileInput, auth: MobileAuth | null) => {
  const refused = requireConfirmedUser(auth);
  if (refused) return refused;
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const rows =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${BigInt(id)} AND ${column("purchases", "purchaser_id")} = ${libraryOwner(auth).id} LIMIT 1`,
        );
  if (rows.length === 0) return fetchError("Could not find purchase");
  throw new HandBackToRails(`${verb} of a purchase that exists`);
};

const hasRows = async (tableName: string, columnName: string, id: bigint): Promise<boolean> =>
  (
    await selectRows(
      Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${column(tableName, columnName)} = ${id} LIMIT 1`,
    )
  ).length > 0;

// PurchasesController#purchase_attributes: fetch_purchase, then Purchase#json_data_for_mobile
async function purchaseAttributes(input: MobileInput, auth: MobileAuth | null) {
  const refused = requireConfirmedUser(auth);
  if (refused) return refused;
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const purchase =
    id === null
      ? null
      : await db.purchase.findFirst({ where: { id: BigInt(id), purchaser_id: libraryOwner(auth).id } });
  // successful_and_not_reversed? || subscription
  if (
    purchase === null ||
    (purchase.subscription_id === null &&
      (purchase.stripe_refunded === true ||
        purchase.chargeback_date !== null ||
        !NON_GIFT_SUCCESS_STATES.includes(purchase.purchase_state ?? "")))
  )
    return fetchError("Could not find purchase");
  if (purchase.subscription_id !== null) throw new HandBackToRails("the subscription_data of a membership purchase");
  if (purchase.preorder_id !== null) throw new HandBackToRails("Preorder#mobile_json_data");
  if (await hasRows("url_redirects", "purchase_id", purchase.id))
    throw new HandBackToRails("UrlRedirect#product_json_data");
  if (await hasRows("refunds", "purchase_id", purchase.id)) throw new NotPortedError("Purchase#amount_refunded_cents");
  if (await hasRows("product_reviews", "purchase_id", purchase.id))
    throw new NotPortedError("Purchase#original_product_review");

  const link = purchase.link_id === null ? null : await db.link.findUnique({ where: { id: purchase.link_id } });
  const creator = link?.user_id == null ? null : await db.user.findUnique({ where: { id: link.user_id } });
  const seller = purchase.seller_id === null ? null : await db.user.findUnique({ where: { id: purchase.seller_id } });
  if (!link || !creator || !seller) throw new NotPortedError("a purchase whose product or seller row is missing");
  if (creator.username === null || creator.username.trim() === "")
    throw new NotPortedError("User#profile_url for a creator without a username");
  const productUpdates = (await preloadProductUpdatesData([purchase])).get(purchase.id)!;

  const [previews] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${link.id} AND ${column("asset_previews", "deleted_at")} IS NULL LIMIT 1`,
  );
  const thumbnails = await thumbnailUrlsByProduct([link.id]);
  return renderJson({
    success: true,
    product: purchaseJsonDataForMobile({
      purchase,
      link: {
        link,
        creator,
        creatorAvatarUrl: await avatarUrl(creator),
        creatorProfileUrl: profileUrl(creator),
        thumbnailOrCoverUrl: thumbnails.get(link.id) ?? null,
        hasAlivePreviews: previews !== undefined,
      },
      seller,
      purchaser: libraryOwner(auth),
      productRating: null,
      amountRefundedCents: 0,
      productUpdatesData: productUpdates,
    }),
  });
}

// SalesController#index. A row the creator-app serializer does not reproduce throws NotPortedError, which hands the request to Rails.
async function salesIndex(input: MobileInput, auth: MobileAuth | null) {
  const query = input.params.query;
  if (query !== undefined && query !== null && typeof query !== "string")
    throw new HandBackToRails("a query that is not a string");
  const page = Math.max(integerParam(input.params.page, 0, "page"), 1);
  const result = await PurchaseSearchService.process({
    seller: auth!.owner.id,
    state: NON_GIFT_SUCCESS_STATES,
    exclude_giftees: true,
    exclude_non_original_subscription_purchases: true,
    exclude_bundle_product_purchases: true,
    exclude_commission_completion_purchases: true,
    seller_query: query === "" ? null : query,
    from: (page - 1) * SALES_PER_PAGE,
    size: SALES_PER_PAGE,
    sort: [{ created_at: { order: "desc" } }, { id: { order: "desc" } }],
    track_total_hits: true,
  });
  if (result.total === null) throw new HandBackToRails("a sales page without a total");
  const pages = Math.ceil(result.total / SALES_PER_PAGE);
  return renderJson({
    success: true,
    purchases: await creatorAppPurchasesJson(result.ids.map((id) => BigInt(id))),
    pagination: { count: result.total, page, pages, next: page < pages ? page + 1 : null },
  });
}

// before_action :fetch_purchase: current_resource_owner.sales.find_by_external_id
async function salesShow(input: MobileInput, auth: MobileAuth | null) {
  // `get :blob_url` on the collection is drawn before the member route, so it is not a sale id.
  if (input.params.id === "blob_url") throw new HandBackToRails("the blob_url collection route");
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const rows =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${BigInt(id)} AND ${column("purchases", "seller_id")} = ${auth!.owner.id} LIMIT 1`,
        );
  if (rows.length === 0) return fetchError("Could not find purchase");
  throw new HandBackToRails("a sale that exists");
}

// SalesController#options: before_action :fetch_purchase, then the product's options.
async function salesOptions(input: MobileInput, auth: MobileAuth | null) {
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const [sale] =
    id === null
      ? []
      : await selectRows<{ link_id: bigint | null }>(
          Prisma.sql`SELECT ${column("purchases", "link_id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${BigInt(id)} AND ${column("purchases", "seller_id")} = ${auth!.owner.id} LIMIT 1`,
        );
  if (sale === undefined) return fetchError("Could not find purchase");
  const link = sale.link_id === null ? null : await findLink(sale.link_id);
  if (link === null) return fetchError("Could not find product");
  return renderJson({ success: true, options: await linkOptions(link) });
}

registerMobile(
  { method: "GET", pattern: "/mobile/purchases/index", scopes: MOBILE_API_SCOPES, run: index },
  { method: "GET", pattern: "/mobile/purchases/search", scopes: MOBILE_API_SCOPES, run: search },
  {
    method: "GET",
    pattern: "/mobile/purchases/purchase_attributes/:id",
    scopes: MOBILE_API_SCOPES,
    run: purchaseAttributes,
  },
  {
    method: "POST",
    pattern: "/mobile/purchases/:id/archive",
    scopes: MOBILE_API_SCOPES,
    run: purchaseAction("an archive"),
  },
  {
    method: "POST",
    pattern: "/mobile/purchases/:id/unarchive",
    scopes: MOBILE_API_SCOPES,
    run: purchaseAction("an unarchive"),
  },
  { method: "DELETE", pattern: "/mobile/purchases/:id", scopes: MOBILE_API_SCOPES, run: purchaseAction("a delete") },
  { method: "GET", pattern: "/mobile/sales", scopes: MOBILE_API_SCOPES, run: salesIndex },
  { method: "GET", pattern: "/mobile/sales/:id", scopes: MOBILE_API_SCOPES, run: salesShow },
  { method: "GET", pattern: "/mobile/sales/:id/options", scopes: MOBILE_API_SCOPES, run: salesOptions },
);
