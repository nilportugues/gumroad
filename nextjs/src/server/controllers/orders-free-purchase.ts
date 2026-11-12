// OrdersController#create for the one shape Node writes: a single free line of a plain one-time USD product, from a signed-out
// buyer or a signed-in one with no cart (orders_free_purchase_parity_spec.rb). The purchase, its order, charge, url redirect,
// purchase event and receipt job are written by createFreeOrder; this file decides, before any write, whether the request is that
// shape, and hands the rest back to Rails whole.
//
// Handed back, each checked before the first statement that writes: a workflow on the seller (ScheduleWorkflowEmailsWorker is
// pushed in the transition), a product with a purchase limit, a buyer with a live cart (the order reminder and the cart are
// rewritten), an affiliate on the line or in a cookie, an order of more than one line, a repeated free download from one
// address (the velocity block would trip after the purchase is saved), a discount code, a membership or any other product shape.
import { Prisma } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { defaultCheckoutEffects } from "../models/checkout-effects.ts";
import { ago } from "../models/concerns/ruby-time.ts";
import { LinkFlags } from "../models/link.ts";
import { purchaseResponse } from "../models/purchase-response.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import type { LinkRow } from "../presenters/product-reads.ts";
import { createFreeOrder, findUserById } from "../services/free-order-create.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { remoteIp, type MutationInput } from "./mutation.ts";

// Affiliate::Cookies::AFFILIATE_COOKIE_NAME_PREFIX
const AFFILIATE_COOKIE_NAME_PREFIX = "_gumroad_affiliate_id_";
// Purchase::Blockable#block_fraudulent_free_purchases!: the defaults of Redis keys nobody has set
const DEFAULT_FREE_PURCHASES_WATCH_HOURS = 4;
const DEFAULT_MAX_ALLOWED_FREE_PURCHASES_OF_SAME_PRODUCT = 2;
const FREE_PURCHASES_WATCH_HOURS_KEY = "free_purchases_watch_hours";
const MAX_ALLOWED_FREE_PURCHASES_KEY = "max_allowed_free_purchases_of_same_product";
const FRAUDULENT_FREE_PURCHASES_BLOCK_HOURS_KEY = "fraudulent_free_purchases_block_hours";
// Native types whose purchases carry more than the product's price
const SEO_REFERRER = /(google|bing|yahoo|yandex|duckduckgo)(\.[a-z]{2,3})(\.[a-z]{2})?$/iu;
const EXCLUDED_NATIVE_TYPES = new Set(["call", "commission", "coffee", "membership", "bundle"]);

const handBack = (reason: string): never => {
  throw new HandBackToRails(`orders free purchase ${reason}`);
};
const blank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  (typeof value === "string" && /^[\s\u0085]*$/u.test(value));
const star = (name: string) => Prisma.raw(`\`${name}\`.*`);

// A product Rails would sell for nothing with nothing more than the purchase row: a plain one-time USD product priced at 0.
function assertPlainFreeProduct(row: LinkRow): void {
  const flag = (name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(row.flags, name);
  if (
    flag("is_recurring_billing") ||
    flag("free_trial_enabled") ||
    flag("is_in_preorder_state") ||
    flag("is_physical") ||
    flag("is_bundle") ||
    flag("is_tiered_membership") ||
    Boolean(row.require_shipping) ||
    EXCLUDED_NATIVE_TYPES.has(String(row.native_type)) ||
    String(row.price_currency_type).toLowerCase() !== "usd" ||
    row.default_offer_code_id !== null ||
    (row.purchase_type !== null && row.purchase_type !== 0)
  )
    handBack("for a product that is not a plain one-time USD product");
  if (row.price_cents !== 0 && Number(row.price_cents) !== 0) handBack("for a product that is not free");
  if (row.max_purchase_count !== null) handBack("for a product with a purchase limit");
}

// Reads that decide the hand-backs a write could not take back.
async function assertNoWriteNeedsRails(
  input: MutationInput,
  line: Record<string, unknown>,
  row: LinkRow,
  buyerId: bigint | null,
) {
  const { request, params } = input;
  if (!blank(line.affiliate_id)) handBack("with an affiliate on the line");
  for (const name of request.cookies.keys())
    if (name.startsWith(AFFILIATE_COOKIE_NAME_PREFIX)) handBack("with an affiliate cookie");
  if (!blank(line.discount_code)) handBack("with a discount code");
  // Events#seo_referrer?: the event's visit_id would carry the from_seo flag
  if (SEO_REFERRER.test(input.peekState().signupReferrer ?? ""))
    handBack("from a visitor who arrived from a search engine");

  // User#has_workflows?
  const workflows = await selectRows(
    Prisma.sql`SELECT ${star("workflows")} FROM ${table("workflows")} WHERE ${column("workflows", "seller_id")} = ${row.user_id} AND ${column("workflows", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (workflows.length > 0) handBack("of a seller with a workflow");

  // Cart.fetch_by
  const guid = request.cookies.get("_gumroad_guid") ?? input.peekState().mintedGuid ?? null;
  const carts =
    buyerId !== null
      ? await selectRows(
          Prisma.sql`SELECT ${star("carts")} FROM ${table("carts")} WHERE ${column("carts", "user_id")} = ${buyerId} AND ${column("carts", "deleted_at")} IS NULL LIMIT 1`,
        )
      : guid
        ? await selectRows(
            Prisma.sql`SELECT ${star("carts")} FROM ${table("carts")} WHERE ${column("carts", "deleted_at")} IS NULL AND ${column("carts", "browser_guid")} = ${guid} AND ${column("carts", "user_id")} IS NULL LIMIT 1`,
          )
        : [];
  if (carts.length > 0) handBack("from a buyer with a cart");

  // Purchase::Blockable#block_fraudulent_free_purchases!, counted before this purchase exists: it trips when this one makes one
  // more than the allowed count.
  const [watch, max] = await defaultCheckoutEffects.redisMget([
    FREE_PURCHASES_WATCH_HOURS_KEY,
    MAX_ALLOWED_FREE_PURCHASES_KEY,
    FRAUDULENT_FREE_PURCHASES_BLOCK_HOURS_KEY,
  ]);
  const watchHours = watch == null ? DEFAULT_FREE_PURCHASES_WATCH_HOURS : Number.parseInt(watch, 10) || 0;
  const maxAllowed = max == null ? DEFAULT_MAX_ALLOWED_FREE_PURCHASES_OF_SAME_PRODUCT : Number.parseInt(max, 10) || 0;
  const ip = remoteIp(request);
  const since = new Date(Math.floor(ago({ hours: watchHours }, new Date()).getTime() / 1000) * 1000);
  const rows = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("purchases")} WHERE ${column("purchases", "link_id")} = ${row.id} AND ${column("purchases", "purchase_state")} = ${"successful"} AND (purchases.subscription_id IS NULL OR purchases.flags & '4' = '4' OR purchases.flags & '32' = '32') AND ${column("purchases", "total_transaction_cents")} = ${0} AND ${column("purchases", "ip_address")} = ${ip} AND ${column("purchases", "created_at")} >= ${since} AND (purchaser_id IS NULL OR purchaser_id != ${String(row.user_id)})`,
  );
  if (Number(rows[0]!["COUNT(*)"]) + 1 > maxAllowed) handBack("from an address that downloaded it repeatedly");
  void params;
}

// The response of OrdersController#create for the one free line, or a hand-back.
export async function freeOrderResponse(
  input: MutationInput,
  line: Record<string, unknown>,
  row: LinkRow,
  canBuyerSignUp: boolean,
): Promise<ActionResult> {
  const { request, params } = input;
  assertPlainFreeProduct(row);
  const buyer = railsLoggedInUser(input.context);
  if (buyer && blank(buyer.email)) handBack("from a signed-in buyer with no email");
  await assertNoWriteNeedsRails(input, line, row, buyer?.id ?? null);

  const ip = remoteIp(request);
  if (ip === null) return handBack("without a remote address");
  const { chain } = input;
  const sessionId = chain.session.data.session_id;
  const result = await createFreeOrder({
    params: Object.fromEntries(Object.entries(params).filter(([name]) => name !== "line_items")),
    line,
    ip,
    browserGuid: request.cookies.get("_gumroad_guid") ?? input.peekState().mintedGuid ?? null,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    isMobile: false,
    buyer: buyer ? await findUserById(buyer.id) : null,
    userAgent: request.headers.get("user-agent"),
    acceptLanguage: request.headers.get("accept-language"),
    referer: request.headers.get("referer"),
    pathInfo: input.url.pathname,
  }).catch((error: unknown) => {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  });

  return json({
    success: true,
    line_items: { [String(line.uid)]: purchaseResponse(result.facts) },
    offer_codes: [],
    can_buyer_sign_up: canBuyerSignUp,
  });
}
