// Port of app/controllers/api/mobile/purchases_controller.rb and app/controllers/api/mobile/sales_controller.rb (index, show, options).
//
// Served here: the unconfirmed-account 403, the 404 for a purchase that is not the caller's, the empty lists, sales#index rows
// whose Purchase#as_json(creator_app_api: true) is ported (presenters/mobile-serializers.ts: a USD or stored-rate currency, no recurrence), and
// purchase_attributes, archive, unarchive and destroy of a purchase that is not a membership or a gift (refunds, a review, a url
// redirect and a preorder are serialized) whose seller and product have no post. Everything else (the rest of those, a non-empty
// library page, sales#show) goes to Rails whole, because the posts of the product-updates preloader are not ported.
import { Prisma, type Purchase, type Subscription, type User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { offerCodeDisplays } from "../models/offer-code-display.ts";
import { NOT_RECURRING_CHARGE, purchaseFlag, states } from "../models/offer-code.ts";
import { canPingSales } from "../models/ping-notification.ts";
import { type LibraryFlag, loadLibraryPurchase, setLibraryFlag } from "../models/purchase-library-writes.ts";
import { preloadProductUpdatesData } from "../models/purchase-product-updates.ts";
import { affiliateDetails, shipmentDetails, skuDetails } from "../models/sale-details.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { profileUrl } from "../page-props/buyer/users.ts";
import { buildCharges, buildCustomerEmails, findSellerSale } from "../page-props/customers/customer-details.ts";
import { customersOfPurchases } from "../page-props/customers/customers.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { mobilePreview } from "../presenters/mobile-preview.ts";
import {
  amountRefundedCentsByPurchase,
  creatorAppPurchasesJson,
  subscriptionRecurrenceLabels,
  ratingByPurchase,
  thumbnailUrlsByProduct,
} from "../presenters/mobile-serializer-reads.ts";
import { jsonTime, purchaseJsonDataForMobile, type SaleDetails } from "../presenters/mobile-serializers.ts";
import { urlRedirectMobileData } from "../presenters/mobile-url-redirect.ts";
import { linkOptions } from "../presenters/product-props.ts";
import { findLink } from "../presenters/product-reads.ts";
import { PurchaseFlags } from "../search/flags.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { HandBackToRails } from "./application-controller.ts";
import { receiptUrlOptions } from "./customer-details.ts";
import { fetchError, FORBIDDEN, registerMobile, renderJson, type MobileAuth, type MobileInput } from "./mobile-api.ts";
import { blobUrl } from "./mobile-sales-actions.ts";

const MOBILE_API_SCOPES = ["mobile_api"];
const BAD_REQUEST = 400;
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

// Pagy.new's checks, in its order (page, limit, overflow); Api::Mobile::BaseController renders the VariableError as a 400.
function pagyRefusal(count: number, page: number, limit: number) {
  const last = Math.max(Math.ceil(count / Math.max(limit, 1)), FIRST_PAGE);
  const message =
    page < FIRST_PAGE
      ? `expected :page >= 1; got ${page}`
      : limit < 1
        ? `expected :limit >= 1; got ${limit}`
        : page > last
          ? `expected :page in 1..${last}; got ${page}`
          : null;
  return message === null ? null : { ...renderJson({ error: { message } }, BAD_REQUEST), rescued: true };
}

// PagyPresenter#metadata for a Pagy of `count` rows, `items` to a page, on a page that exists.
function pagyMetadata(count: number, page: number, items: number) {
  const pages = Math.max(Math.ceil(count / items), FIRST_PAGE);
  return {
    count,
    items,
    page,
    pages,
    prev: page > FIRST_PAGE ? page - 1 : null,
    next: page < pages ? page + 1 : null,
    last: pages,
  };
}

// Purchase::ALL_SUCCESS_STATES
const ALL_SUCCESS_STATES = [...NON_GIFT_SUCCESS_STATES, "gift_receiver_purchase_successful"];

// Purchase.for_mobile_listing for one buyer, without its order and includes.
const listingWhere = (buyerId: bigint) =>
  Prisma.sql`${column("purchases", "purchaser_id")} = ${buyerId} AND ${states(ALL_SUCCESS_STATES)} AND ${purchaseFlag("is_deleted_by_buyer", false)} AND ${purchaseFlag("is_additional_contribution", false)} AND ${NOT_RECURRING_CHARGE} AND ${purchaseFlag("is_gift_sender_purchase", false)} AND ${NOT_REFUNDED_EXCEPT_SUBSCRIPTIONS} AND ${NOT_CHARGEDBACK_OR_REVERSED} AND ${purchaseFlag("is_archived_original_subscription_purchase", false)} AND ${NOT_RENTAL_EXPIRED}`;

const NOT_REFUNDED_EXCEPT_SUBSCRIPTIONS = Prisma.raw(
  "((purchases.subscription_id IS NULL AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)) OR purchases.subscription_id IS NOT NULL)",
);
const NOT_CHARGEDBACK_OR_REVERSED = Prisma.raw(
  "(purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0))",
);
const NOT_RENTAL_EXPIRED = Prisma.raw("(purchases.rental_expired = FALSE OR purchases.rental_expired IS NULL)");

// The listing's rows by id, in the order the ids came in; an id with no row (deleted in between) is dropped.
async function purchasesInOrder(ids: bigint[]): Promise<Purchase[]> {
  if (ids.length === 0) return [];
  const found = await db.purchase.findMany({ where: { id: { in: ids } } });
  const byId = new Map(found.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

// Api::Mobile::PurchasesController#purchases_to_json. A purchase Node does not serialize (a membership, a gift, a media location, a
// post to show) hands the whole page back before anything is answered.
async function libraryJson(rows: Purchase[], auth: MobileAuth | null, includeProductUpdates: boolean) {
  const ids = rows.map((row) => row.id);
  const shared = newShared();
  shared.refunds = await amountRefundedCentsByPurchase(ids);
  shared.ratings = await ratingByPurchase(ids);
  if (includeProductUpdates && rows.length > 0) shared.updates = await preloadProductUpdatesData(rows);
  const json: Record<string, unknown>[] = [];
  for (const row of rows)
    json.push((await plainPurchaseJson(row, auth, { includeProductUpdates, shared })).render(row));
  return json;
}

async function index(input: MobileInput, auth: MobileAuth | null) {
  const refused = requireConfirmedUser(auth);
  if (refused) return refused;
  const page = integerParam(input.params.page, FIRST_PAGE, "page");
  const perPage = Math.min(
    Math.max(integerParam(input.params.per_page, DEFAULT_PER_PAGE, "per_page"), 1),
    MAX_PER_PAGE,
  );
  const owner = libraryOwner(auth);
  const where = listingWhere(owner.id);
  const [counted] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("purchases")} WHERE ${where}`,
  );
  const count = Number(counted?.count ?? 0);
  const refusal = pagyRefusal(count, page, perPage);
  if (refusal) return refusal;
  const idRows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${where} ORDER BY ${column("purchases", "id")} DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
  );
  const rows = await purchasesInOrder(idRows.map((row) => BigInt(row.id)));
  return renderJson({
    success: true,
    products: await libraryJson(rows, auth, true),
    user_id: owner.external_id,
    meta: { pagination: pagyMetadata(count, page, perPage) },
  });
}

// ActiveModel::Type::Boolean#cast: only these strings are false.
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);
// String#present?: not blank (Ruby's blank also covers whitespace)
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// ActiveRecord::Base.sanitize_sql_like
const sanitizeSqlLike = (value: string) => value.replace(/[\\%_]/gu, (char) => `\\${char}`);

// PurchasesController#search_purchases: the filters and the order of the search listing.
async function searchListing(input: MobileInput, buyerId: bigint) {
  const conditions = [listingWhere(buyerId)];
  const { q, seller, archived, purchase_ids: purchaseIds, order } = input.params;
  const joins = present(q)
    ? Prisma.sql`LEFT JOIN ${table("links")} ON ${column("links", "id")} = ${column("purchases", "link_id")} LEFT JOIN ${table("users")} ON ${column("users", "id")} = ${column("purchases", "seller_id")}`
    : Prisma.empty;
  if (present(q)) {
    const pattern = `%${sanitizeSqlLike(q)}%`;
    conditions.push(
      Prisma.sql`(${column("links", "name")} LIKE ${pattern} OR ${column("users", "name")} LIKE ${pattern})`,
    );
  }
  if (present(seller)) {
    // Resolved to ids first, as the controller does, so the seller filter is plain ids.
    const sellers = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "external_id")} = ${seller}`,
    );
    conditions.push(
      sellers.length === 0
        ? Prisma.sql`1=0`
        : Prisma.sql`${column("purchases", "seller_id")} IN (${Prisma.join(sellers.map((row) => BigInt(row.id)))})`,
    );
  }
  if (present(archived)) conditions.push(purchaseFlag("is_archived", !FALSE_VALUES.has(archived)));
  if (present(purchaseIds)) {
    const decrypted = decrypt(purchaseIds);
    conditions.push(Prisma.sql`${column("purchases", "id")} IN (${decrypted === null ? 0n : BigInt(decrypted)})`);
  }
  const orderBy =
    order === undefined || order === null || order === "date-desc"
      ? Prisma.sql`${column("purchases", "created_at")} DESC, ${column("purchases", "id")} DESC`
      : order === "date-asc"
        ? Prisma.sql`${column("purchases", "created_at")} ASC, ${column("purchases", "id")} ASC`
        : Prisma.sql`${column("purchases", "id")} DESC`;
  return { joins, where: Prisma.join(conditions, " AND "), orderBy };
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
  const owner = libraryOwner(auth);
  const { joins, where, orderBy } = await searchListing(input, owner.id);
  const [counted] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("purchases")} ${joins} WHERE ${where}`,
  );
  const count = Number(counted?.count ?? 0);
  const refusal = pagyRefusal(count, page, items);
  if (refusal) return refusal;
  // sellers_from_purchases groups the filtered relation by seller under its own ORDER BY on a column outside the group, so
  // the order of several sellers is MySQL's; one seller (or none) has only one order.
  const sellerRows = await selectRows<{ seller_id: bigint | null; purchases_count: bigint }>(
    Prisma.sql`SELECT ${column("purchases", "seller_id")}, COUNT(*) AS purchases_count FROM ${table("purchases")} ${joins} WHERE ${where} GROUP BY ${column("purchases", "seller_id")}`,
  );
  if (sellerRows.length > 1) throw new HandBackToRails("a purchase search over several sellers");
  const idRows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} ${joins} WHERE ${where} ORDER BY ${orderBy} LIMIT ${items} OFFSET ${(page - 1) * items}`,
  );
  const rows = await purchasesInOrder(idRows.map((row) => BigInt(row.id)));
  const sellers: Record<string, unknown>[] = [];
  for (const row of sellerRows) {
    if (row.seller_id === null) continue;
    const seller = await db.user.findUnique({ where: { id: BigInt(row.seller_id) } });
    if (seller)
      sellers.push({ id: seller.external_id, name: seller.name, purchases_count: Number(row.purchases_count) });
  }
  return renderJson({
    success: true,
    user_id: owner.external_id,
    purchases: await libraryJson(rows, auth, false),
    sellers,
    meta: { pagination: pagyMetadata(count, page, items) },
  });
}

// before_action :fetch_purchase: the caller's purchase, or null for the 404 (`successful_and_not_reversed? || subscription`).
async function fetchPurchase(input: MobileInput, auth: MobileAuth | null): Promise<Purchase | null> {
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const purchase =
    id === null
      ? null
      : await db.purchase.findFirst({ where: { id: BigInt(id), purchaser_id: libraryOwner(auth).id } });
  if (
    purchase === null ||
    (purchase.subscription_id === null &&
      (purchase.stripe_refunded === true ||
        purchase.chargeback_date !== null ||
        !NON_GIFT_SUCCESS_STATES.includes(purchase.purchase_state ?? "")))
  )
    return null;
  return purchase;
}

// Preorder#mobile_json_data for a purchase without a url redirect: the latest purchase when it was charged (its own url redirect,
// which Node does not serialize here, hands back), else the authorization purchase with the release date.
async function preorderSource(purchase: Purchase, productId: bigint, purchaser: User) {
  const [preorder] = await selectRows<{ id: bigint; preorder_link_id: bigint | null }>(
    Prisma.sql`SELECT ${column("preorders", "id")}, ${column("preorders", "preorder_link_id")} FROM ${table("preorders")} WHERE ${column("preorders", "id")} = ${purchase.preorder_id} LIMIT 1`,
  );
  if (preorder?.preorder_link_id == null)
    throw new NotPortedError("a purchase whose preorder or preorder link is missing");
  const [preorderLink] = await selectRows<{ link_id: bigint | null; release_at: Date | null }>(
    Prisma.sql`SELECT ${column("preorder_links", "link_id")}, ${column("preorder_links", "release_at")} FROM ${table("preorder_links")} WHERE ${column("preorder_links", "id")} = ${preorder.preorder_link_id} LIMIT 1`,
  );
  if (preorderLink?.link_id == null || BigInt(preorderLink.link_id) !== productId)
    throw new NotPortedError("a preorder link for another product");
  // Preorder#authorization_purchase is purchases.first and charge_purchase_successful? reads purchases.last
  const purchases = await db.purchase.findMany({
    where: { preorder_id: purchase.preorder_id },
    orderBy: { id: "asc" },
  });
  const first = purchases[0];
  const last = purchases[purchases.length - 1];
  if (first === undefined || last === undefined) throw new NotPortedError("a preorder without purchases");
  const charged = last.purchase_state === "successful";
  if (charged && (await db.urlRedirect.count({ where: { purchase_id: last.id } })) > 0)
    throw new HandBackToRails("the url redirect of a preorder's charge purchase");
  const source = charged ? last : first;
  const sourcePurchaser =
    source.purchaser_id === null
      ? null
      : source.purchaser_id === purchaser.id
        ? purchaser
        : await db.user.findUnique({ where: { id: source.purchaser_id } });
  return {
    source,
    sourcePurchaser,
    preorderData: charged
      ? null
      : { external_id: encrypt(BigInt(preorder.id)), release_at: jsonTime(preorderLink.release_at) },
  };
}

// Subscription#alive? (include_pending_cancellation: true)
const subscriptionAlive = (subscription: Subscription, now: Date): boolean => {
  if (subscription.failed_at !== null || subscription.ended_at !== null) return false;
  return subscription.cancelled_at === null || subscription.cancelled_at > now;
};

// Subscription#termination_reason
function terminationReason(subscription: Subscription): string | null {
  if (subscription.deactivated_at === null) return null;
  if (subscription.failed_at !== null) return "failed_payment";
  if (subscription.ended_at !== null) return "fixed_subscription_period_ended";
  if (subscription.cancelled_at !== null) return "cancelled";
  return null;
}

// Purchase#json_data_for_mobile's subscription_data
const subscriptionData = (subscription: Subscription) => ({
  id: encrypt(subscription.id),
  subscribed_at: jsonTime(subscription.created_at),
  ended_at: jsonTime(subscription.deactivated_at),
  ended_reason: terminationReason(subscription),
});

// Rows a page of purchases shares (products, users, a product's creator-side fields), read once. `refunds`, `ratings` and `updates` are
// the batched reads of a listing; a single purchase reads its own.
type Shared = {
  memo: <V>(key: string, load: () => Promise<V>) => Promise<V>;
  refunds?: Map<bigint, number>;
  ratings?: Map<bigint, number | null>;
  updates?: Map<bigint, Record<string, unknown>[]>;
};

function newShared(): Shared {
  const cache = new Map<string, Promise<unknown>>();
  return {
    memo<V>(key: string, load: () => Promise<V>): Promise<V> {
      let hit = cache.get(key) as Promise<V> | undefined;
      if (hit === undefined) {
        hit = load();
        cache.set(key, hit);
      }
      return hit;
    },
  };
}

// What Purchase#json_data_for_mobile needs for a plain purchase, loaded and checked before any write, so a purchase Node
// cannot serialize hands back (or throws NotPortedError) unchanged. `render` takes the row as the action leaves it.
// `includeProductUpdates: false` is the search listing, which leaves product_updates_data out.
async function plainPurchaseJson(
  purchase: Purchase,
  auth: MobileAuth | null,
  {
    includeProductUpdates = true,
    shared = newShared(),
    purchaser,
    saleDetails,
  }: {
    includeProductUpdates?: boolean;
    shared?: Shared;
    // The seller's view of a sale serializes the buyer, not the library owner.
    purchaser?: User | null;
    saleDetails?: SaleDetails;
  } = {},
) {
  const buyer = purchaser === undefined ? libraryOwner(auth) : purchaser;
  const subscription =
    purchase.subscription_id === null
      ? null
      : await db.subscription.findUnique({ where: { id: purchase.subscription_id } });
  if (purchase.subscription_id !== null && subscription === null)
    throw new NotPortedError("a purchase whose subscription row is missing");
  const amountRefundedCents =
    (shared.refunds ?? (await amountRefundedCentsByPurchase([purchase.id]))).get(purchase.id) ?? 0;
  // Purchase#original_product_review: a membership's review sits on its true original purchase (the first original by id)
  let reviewHolderId = purchase.id;
  if (subscription !== null) {
    const [original] = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscription.id} AND ${PurchaseFlags.condition("is_original_subscription_purchase", true)} ORDER BY ${column("purchases", "id")} ASC LIMIT 1`,
    );
    if (original === undefined) throw new NotPortedError("a subscription without an original purchase");
    reviewHolderId = BigInt(original.id);
  }
  const productRating =
    (subscription === null && shared.ratings ? shared.ratings : await ratingByPurchase([reviewHolderId])).get(
      reviewHolderId,
    ) ?? null;

  const userById = (id: bigint) => shared.memo(`user:${id}`, () => db.user.findUnique({ where: { id } }));
  const link =
    purchase.link_id === null
      ? null
      : await shared.memo(`link:${purchase.link_id}`, () => db.link.findUnique({ where: { id: purchase.link_id! } }));
  const creator = link?.user_id == null ? null : await userById(link.user_id);
  const seller = purchase.seller_id === null ? null : await userById(purchase.seller_id);
  if (!link || !creator || !seller) throw new NotPortedError("a purchase whose product or seller row is missing");
  if (creator.username === null || creator.username.trim() === "")
    throw new NotPortedError("User#profile_url for a creator without a username");
  const redirects = await db.urlRedirect.findMany({ where: { purchase_id: purchase.id }, take: 2 });
  // has_one :url_redirect reads an arbitrary row when there are several
  if (redirects.length > 1) throw new HandBackToRails("a purchase with several url redirects");
  const redirect = redirects[0];
  if (redirect?.installment_id != null) throw new NotPortedError("a url redirect of a post");
  // UrlRedirect#product_json_data leaves file_data out for a membership that is no longer alive
  const urlRedirect =
    redirect === undefined
      ? undefined
      : subscription !== null && !subscriptionAlive(subscription, new Date())
        ? { urlRedirectExternalId: encrypt(redirect.id), urlRedirectToken: redirect.token, fileData: null }
        : await urlRedirectMobileData({
            redirect,
            purchase,
            purchaser: buyer,
            subscription: null,
            product: link,
            seller,
          });
  const preorder =
    urlRedirect === undefined && purchase.preorder_id !== null
      ? await preorderSource(purchase, link.id, buyer ?? failNotPorted("a preorder of a guest buyer"))
      : undefined;
  const updatesFor = preorder?.source ?? purchase;
  let productUpdates: Record<string, unknown>[] | null = null;
  if (includeProductUpdates)
    productUpdates =
      shared.updates?.get(updatesFor.id) ?? (await preloadProductUpdatesData([updatesFor])).get(updatesFor.id)!;

  const linkInput = await shared.memo(`link-input:${link.id}`, async () => {
    const thumbnails = await thumbnailUrlsByProduct([link.id]);
    const { preview, thumbnailOrCoverUrl } = await mobilePreview(link.id, thumbnails.get(link.id) ?? null);
    return {
      link,
      creator,
      creatorAvatarUrl: await avatarUrl(creator),
      creatorProfileUrl: profileUrl(creator),
      thumbnailOrCoverUrl,
      preview,
    };
  });
  return {
    seller,
    render: (row: Purchase) =>
      purchaseJsonDataForMobile({
        purchase: row,
        link: linkInput,
        seller,
        purchaser: buyer,
        saleDetails,
        productRating,
        amountRefundedCents,
        productUpdatesData: productUpdates,
        urlRedirect,
        subscriptionData: subscription === null ? undefined : subscriptionData(subscription),
        // The write left this row as it is; the preorder's source purchase is read after it, so it is this row when it is the same one.
        preorder:
          preorder === undefined
            ? undefined
            : { ...preorder, source: preorder.source.id === row.id ? row : preorder.source },
      }),
  };
}

// PurchasesController#purchase_attributes: fetch_purchase, then Purchase#json_data_for_mobile
async function purchaseAttributes(input: MobileInput, auth: MobileAuth | null) {
  const refused = requireConfirmedUser(auth);
  if (refused) return refused;
  const purchase = await fetchPurchase(input, auth);
  if (purchase === null) return fetchError("Could not find purchase");
  const plain = await plainPurchaseJson(purchase, auth);
  return renderJson({ success: true, product: plain.render(purchase) });
}

// #archive, #unarchive and #destroy: `save!` / `update!` of one flag (the library's write), then the purchase's JSON.
const libraryFlagAction =
  (flag: LibraryFlag, value: boolean) => async (input: MobileInput, auth: MobileAuth | null) => {
    const refused = requireConfirmedUser(auth);
    if (refused) return refused;
    const purchase = await fetchPurchase(input, auth);
    if (purchase === null) return fetchError("Could not find purchase");
    // `save!` revalidates a subscription purchase against the card processor; no recording proves the write of a valid one.
    if (purchase.subscription_id !== null) throw new HandBackToRails("a library write of a membership purchase");
    const plain = await plainPurchaseJson(purchase, auth);
    const record = loadLibraryPurchase(purchase, plain.seller.timezone);
    await setLibraryFlag(record, flag, value);
    return renderJson({ success: true, product: plain.render(record.attributes) });
  };

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
  if (input.params.id === "blob_url") return blobUrl(input, auth);
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const sale =
    id === null ? null : await db.purchase.findFirst({ where: { id: BigInt(id), seller_id: auth!.owner.id } });
  if (sale === null) return fetchError("Could not find purchase");
  return renderJson(await saleJson(sale, input, auth!));
}

function failNotPorted(what: string): never {
  throw new NotPortedError(what);
}

// Purchase#variant_details_hash for one SKU or variants of distinct categories (the key order of that hash is not stable in Rails). Two variants of one category, a SKU among several and a missing category are Rails'.
async function saleVariants(purchase: Purchase) {
  const variants = await selectRows<{
    id: bigint;
    type: string | null;
    name: string | null;
    variant_category_id: bigint | null;
    custom_sku: string | null;
    flags: number;
    link_id: number | null;
  }>(
    Prisma.sql`SELECT ${column("base_variants", "id")}, ${column("base_variants", "type")}, ${column("base_variants", "name")}, ${column("base_variants", "variant_category_id")}, ${column("base_variants", "custom_sku")}, ${column("base_variants", "flags")}, ${column("base_variants", "link_id")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchase.id} ORDER BY ${column("base_variants", "id")} ASC`,
  );
  if (variants.length === 0) return { variants: null, sku: null };
  const [first] = variants;
  if (variants.length === 1 && first!.type === "Sku") return skuDetails({ ...first!, id: Number(first!.id) });
  if (variants.some((variant) => variant.type !== "Variant" || variant.variant_category_id === null))
    failNotPorted(variants.length > 1 ? "a sale with a SKU among several variants" : "a variant without a category");
  const categoryIds = [...new Set(variants.map((variant) => variant.variant_category_id!))];
  if (categoryIds.length !== variants.length) failNotPorted("a sale with several variants of one category");
  const categories = await selectRows<{ id: bigint; title: string | null }>(
    Prisma.sql`SELECT ${column("variant_categories", "id")}, ${column("variant_categories", "title")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "id")} IN (${Prisma.join(categoryIds)})`,
  );
  const titles = new Map(categories.map((category) => [BigInt(category.id), category.title]));
  if (categoryIds.some((id) => !titles.has(BigInt(id)))) failNotPorted("a variant whose category row is missing");
  return {
    variants: Object.fromEntries(
      variants.map((variant) => [
        encrypt(BigInt(variant.variant_category_id!)),
        {
          title: titles.get(BigInt(variant.variant_category_id!)),
          selected_variant: { id: encrypt(BigInt(variant.id)), name: variant.name },
        },
      ]),
    ),
    sku: null,
  };
}

// SalesController#show: the purchase as the seller sees it, its customer, charges and emails. A sale with an upsell, a purchasing power
// discount or a bundle goes to Rails whole, like everything the readers below do not serialize.
async function saleJson(sale: Purchase, input: MobileInput, auth: MobileAuth) {
  const seller = auth.owner;
  if (PurchaseFlags.isSet(sale.flags, "is_bundle_purchase")) failNotPorted("a bundle purchase");
  if (PurchaseFlags.isSet(sale.flags, "is_purchasing_power_parity_discounted"))
    failNotPorted("a purchasing power discount");
  const affiliate = await affiliateDetails(sale);
  const shipment = await shipmentDetails(sale);
  const [upsell] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("upsell_purchases")} WHERE ${column("upsell_purchases", "purchase_id")} = ${sale.id} LIMIT 1`,
  );
  if (upsell !== undefined) failNotPorted("a sale of an upsell");
  const link = sale.link_id === null ? null : await db.link.findUnique({ where: { id: sale.link_id } });
  if (link === null) failNotPorted("a sale without a product");
  const offerCode = (await offerCodeDisplays([sale], () => link.price_currency_type)).get(String(sale.id)) ?? null;
  const { variants, sku } = await saleVariants(sale);
  const recurrenceLabel = (await subscriptionRecurrenceLabels([sale])).get(sale.subscription_id ?? 0n);
  const saleDetails = { variants, sku, shipment, offerCode, affiliate, recurrenceLabel };
  const buyer = sale.purchaser_id === null ? null : await db.user.findUnique({ where: { id: sale.purchaser_id } });
  if (sale.purchaser_id !== null && buyer === null) failNotPorted("a sale whose purchaser row is missing");

  const plain = await plainPurchaseJson(sale, auth, { purchaser: buyer, saleDetails });
  const purchase = plain.render(sale);
  const externalId = encrypt(sale.id);
  const context: SellerContext = { user: seller, seller, memberships: [] };
  const row = await findSellerSale(seller.id, externalId);
  return {
    success: true,
    purchase,
    customer: (await customersOfPurchases(context, [String(sale.id)], "id"))[0],
    charges: await buildCharges(row),
    emails: await buildCustomerEmails(seller, row, receiptUrlOptions(input.request)),
    product_purchases: [],
    can_ping: await canPingSales(seller),
  };
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
    run: libraryFlagAction("is_archived", true),
  },
  {
    method: "POST",
    pattern: "/mobile/purchases/:id/unarchive",
    scopes: MOBILE_API_SCOPES,
    run: libraryFlagAction("is_archived", false),
  },
  {
    method: "DELETE",
    pattern: "/mobile/purchases/:id",
    scopes: MOBILE_API_SCOPES,
    run: libraryFlagAction("is_deleted_by_buyer", true),
  },
  { method: "GET", pattern: "/mobile/sales", scopes: MOBILE_API_SCOPES, run: salesIndex },
  { method: "GET", pattern: "/mobile/sales/:id", scopes: MOBILE_API_SCOPES, run: salesShow },
  { method: "GET", pattern: "/mobile/sales/:id/options", scopes: MOBILE_API_SCOPES, run: salesOptions },
);
