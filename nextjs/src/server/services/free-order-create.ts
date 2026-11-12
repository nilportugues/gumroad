// OrdersController#create for one free line, from the controller's fetch of the product to the receipt job:
// Order::CreateService -> Purchase::CreateService (build_purchase, prepare_for_charge!), Order::ChargeService (the charge row,
// the free-purchase transition), then the controller's utm attribution, purchase event and charge receipt. Statements, Redis
// reads, Flipper reads and job pushes go out in the order the Rails recording made them (purchase-create.golden.json).
//
// Anything that would write more than a plain free purchase hands back (NotPortedError) before the first write: the callers
// that serve this check the cheap shapes up front, these guards are the net under them.
import { createHash } from "node:crypto";

import { Prisma, type Link, type Purchase, type User } from "@prisma/client";

import { geoIpLookup } from "../infra/geo-ip.ts";
import { ChargePurchases } from "../models/charge-purchase.ts";
import { Charges } from "../models/charge-record.ts";
import { defaultCheckoutEffects, type CheckoutEffects } from "../models/checkout-effects.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { setAssociation } from "../models/concerns/rails-validations.ts";
import { Events } from "../models/event.ts";
import { LinkFlags } from "../models/link.ts";
import { Orders } from "../models/order.ts";
import {
  assertFreeCheckoutPurchase,
  Purchases,
  withContext,
  type PurchaseContext,
  type PurchaseRecord,
} from "../models/purchase-create.ts";
import type { PurchaseResponseFacts } from "../models/purchase-response.ts";
import { PurchaseSalesTaxInfos } from "../models/purchase-sales-tax-info.ts";
import { markFreePurchaseSuccessful, type MarkSuccessfulResult } from "../models/purchase-success.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { UserFlags, NotPortedError } from "../models/user.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { loadPurchaseResponseFacts } from "./purchase-response-facts.ts";

const star = (name: string) => Prisma.raw(`\`${name}\`.*`);
// PurchaseErrorCode and Purchase::CreateService::RESERVED_URL_PARAMETERS
const RESERVED_URL_PARAMETERS = new Set([
  "code",
  "wanted",
  "referrer",
  "email",
  "as_modal",
  "as_embed",
  "debug",
  "affiliate_id",
]);
// Event referrers are cut to the 191 characters the column holds (`referrer[0..190]`).
const EVENT_REFERRER_LENGTH = 191;

export type FreeOrderRequest = {
  // The order-level params OrdersController#permitted_order_params lets through
  params: Record<string, unknown>;
  // The one line item
  line: Record<string, unknown>;
  ip: string;
  browserGuid: string | null;
  sessionId: string | null;
  isMobile: boolean;
  // `logged_in_user`
  buyer: User | null;
  // Request headers the purchase event records
  userAgent: string | null;
  acceptLanguage: string | null;
  referer: string | null;
  pathInfo: string;
  now?: () => Date;
  effects?: CheckoutEffects;
};

export type FreeOrderResult = {
  order: { id: bigint };
  purchase: PurchaseRecord;
  link: Link;
  seller: User;
  purchaser: User | null;
  charge: { id: bigint };
  urlRedirect: MarkSuccessfulResult["urlRedirect"];
  // The reads `purchaseResponse` renders from
  facts: PurchaseResponseFacts;
};

type OrderRecord = ReturnType<typeof Orders.build>;

const handBack = (what: string): never => {
  throw new NotPortedError(`A free order with ${what}`, "app/services/order/create_service.rb");
};

const blank = (value: unknown): boolean =>
  value == null || value === false || (typeof value === "string" && value.trim() === "");
const text = (value: unknown, name: string): string | null => {
  if (value == null) return null;
  if (typeof value !== "string") return handBack(`a ${name} that is not text`);
  return value;
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function findOne<T>(tableName: string, where: Prisma.Sql, model: Prisma.ModelName): Promise<T | null> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star(tableName)} FROM ${table(tableName)} WHERE ${where} LIMIT 1`,
  );
  return row ? castRow<never>(model, row) : null;
}

// RefundPolicy::ALLOWED_REFUND_PERIODS_IN_DAYS and DEFAULT_REFUND_PERIOD_IN_DAYS
const REFUND_POLICY_TITLES: Record<number, string> = {
  0: "No refunds allowed",
  7: "7-day money back guarantee",
  14: "14-day money back guarantee",
  30: "30-day money back guarantee",
  183: "6-month money back guarantee",
};
const DEFAULT_REFUND_PERIOD_IN_DAYS = 30;

// The attributes Purchase::CreateService copies from a RefundPolicy; its `title` is derived from the period.
async function findRefundPolicy(where: Prisma.Sql): Promise<PurchaseContext["refundPolicy"]> {
  const [row] = await selectRows<{ max_refund_period_in_days: number | null; fine_print: string | null }>(
    Prisma.sql`SELECT ${star("refund_policies")} FROM ${table("refund_policies")} WHERE ${where} LIMIT 1`,
  );
  if (!row) return null;
  const days = row.max_refund_period_in_days ?? DEFAULT_REFUND_PERIOD_IN_DAYS;
  return { max_refund_period_in_days: days, title: REFUND_POLICY_TITLES[days] ?? "", fine_print: row.fine_print };
}

export const findLinkByPermalink = (permalink: string) =>
  findOne<Link>("links", Prisma.sql`${column("links", "unique_permalink")} = ${permalink}`, "Link");
export const findUserById = (id: bigint | number) =>
  findOne<User>("users", Prisma.sql`${column("users", "id")} = ${id}`, "User");

// Purchase::CreateService#parse_url_parameters
function parseUrlParameters(raw: unknown): Record<string, unknown> | null {
  if (blank(raw)) return null;
  let source = text(raw, "url_parameters")!;
  if (/\{ *'/u.test(source)) source = source.replaceAll("'", '"');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObject(parsed) || Object.keys(parsed).length === 0) return null;
  const kept = Object.fromEntries(Object.entries(parsed).filter(([name]) => !RESERVED_URL_PARAMETERS.has(name)));
  return kept;
}

// The json_data JSON of the purchase: the keys in the order the model declares them, unset ones left out.
function jsonDataOf(
  locale: string | null,
  perceived: number,
  recommender: string | null,
  preDiscountUnitPrice: number | null,
): string {
  const data: Record<string, unknown> = {};
  if (locale !== null) data.locale = locale;
  data.perceived_price_cents = perceived;
  data.recommender_model_name = recommender;
  data.pre_discount_unit_price_cents = preDiscountUnitPrice;
  return JSON.stringify(data);
}

const wholeNumber = (value: unknown, name: string): number | null => {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,15}$/u.test(value)) return Number(value);
  return handBack(`a ${name} that is not a whole number`);
};

// Purchase::CreateService#build_purchase and the reads that come with it, in the order Rails sends them. Returns the purchase
// and the context the model hooks read.
async function buildPurchase(req: FreeOrderRequest, link: Link, seller: User, effects: CheckoutEffects) {
  const { params, line } = req;
  for (const key of ["is_gift", "giftee_email", "giftee_id", "gift_note", "hide_gifter"])
    if (!blank(params[key])) handBack(`a ${key}`);
  for (const key of ["buyer_currency_quote", "payment_details_source", "vat_id"])
    if (!blank(params[key])) handBack(`a ${key}`);
  if (!blank(line.discount_code)) handBack("a discount code");
  if (!blank(line.tip_cents)) handBack("a tip");
  if (!blank(line.price_id) || (Array.isArray(line.variants) && line.variants.length > 0)) handBack("a variant");
  if (!blank(line.call_start_time)) handBack("a call");
  if (Array.isArray(line.bundle_products) && line.bundle_products.length > 0) handBack("bundle products");
  if (Array.isArray(line.custom_fields) && line.custom_fields.length > 0) handBack("custom fields");
  if (!blank(line.accepted_offer) || !blank(line.perceived_free_trial_duration)) handBack("an upsell or a free trial");
  const billing = params.purchase;
  if (billing != null && !isObject(billing)) handBack("a purchase that is not an object");
  const billingFields = isObject(billing) ? billing : {};
  if (!blank(billingFields.country) || !blank(params.tax_country_election)) handBack("a country");

  const email = blank(params.email) ? null : text(params.email, "email");
  const perceived = wholeNumber(line.perceived_price_cents, "perceived price") ?? 0;
  const submittedTotal = wholeNumber(line.price_cents, "price");
  const quantity = wholeNumber(line.quantity, "quantity") ?? 1;
  if (quantity !== 1) handBack("a quantity other than 1");

  // product.collaborator
  const collaborators = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(
      "`affiliates`.`id`, `affiliates`.`seller_id`, `affiliates`.`affiliate_user_id`, `affiliates`.`affiliate_basis_points`, `affiliates`.`created_at`, `affiliates`.`updated_at`, `affiliates`.`deleted_at`, `affiliates`.`flags`, `affiliates`.`destination_url`, `affiliates`.`type`",
    )} FROM ${table("affiliates")} INNER JOIN ${table("affiliates_links")} ON ${column("affiliates", "id")} = ${column("affiliates_links", "affiliate_id")} LEFT OUTER JOIN ${table("collaborator_invitations")} ON ${column("collaborator_invitations", "collaborator_id")} = ${column("affiliates", "id")} WHERE ${column("affiliates_links", "link_id")} = ${link.id} AND ${column("affiliates", "type")} = ${"Collaborator"} AND ${column("collaborator_invitations", "id")} IS NULL AND ${column("affiliates", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (collaborators.length > 0) handBack("a collaborator");

  // set_purchaser_for
  let buyerByEmail: User | null = null;
  let purchaser: User | null = req.buyer;
  if (!req.buyer) {
    buyerByEmail =
      email === null ? null : await findOne<User>("users", Prisma.sql`${column("users", "email")} = ${email}`, "User");
    const confirmed = buyerByEmail !== null && buyerByEmail.confirmed_at != null;
    purchaser = confirmed && buyerByEmail!.id !== link.user_id ? buyerByEmail : null;
  }

  // build_custom_fields: product.checkout_custom_fields
  const globalFields = await selectRows(
    Prisma.sql`SELECT ${star("custom_fields")} FROM ${table("custom_fields")} WHERE ${column("custom_fields", "seller_id")} = ${link.user_id} AND ((${column("custom_fields", "flags")} & 1 = 0)) AND ${column("custom_fields", "global")} = TRUE`,
  );
  const productFields = await selectRows(
    Prisma.sql`SELECT ${star("custom_fields")} FROM ${table("custom_fields")} INNER JOIN ${table("custom_fields_products")} ON ${column("custom_fields", "id")} = ${column("custom_fields_products", "custom_field_id")} WHERE ${column("custom_fields_products", "product_id")} = ${link.id} AND ((${column("custom_fields", "flags")} & 1 = 0))`,
  );
  if (globalFields.length > 0 || productFields.length > 0) handBack("custom fields");
  // product.bundle_products.alive
  const bundleProducts = await selectRows(
    Prisma.sql`SELECT ${star("bundle_products")} FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${link.id} AND ${column("bundle_products", "deleted_at")} IS NULL`,
  );
  if (bundleProducts.length > 0) handBack("a bundle");

  const urlParameters = parseUrlParameters(
    blank(line.url_parameters) || line.url_parameters === "{}" ? params.url_parameters : line.url_parameters,
  );
  if (urlParameters !== null && Object.keys(urlParameters).length > 0) handBack("url parameters");

  // The refund policy copied onto the purchase
  let refundPolicy: PurchaseContext["refundPolicy"] = null;
  const accountLevel =
    !(await effects.featureActive("seller_refund_policy_disabled_for_all", null)) &&
    !(await effects.featureActive("account_level_refund_policy_delayed_for_sellers", `User;${seller.id}`)) &&
    UserFlags.isSet(seller.flags, "refund_policy_enabled");
  if (accountLevel) {
    refundPolicy = await findRefundPolicy(
      Prisma.sql`${column("refund_policies", "seller_id")} = ${seller.id} AND ${column("refund_policies", "product_id")} IS NULL`,
    );
    if (refundPolicy === null) handBack("an account-level refund policy that is missing");
  } else if (LinkFlags.isSet(link.flags, "product_refund_policy_enabled")) {
    // The flag can outlive the row, in which case the purchase gets no policy
    refundPolicy = await findRefundPolicy(Prisma.sql`${column("refund_policies", "product_id")} = ${link.id}`);
  }

  const geo = geoIpLookup(req.ip);
  const referrer = blank(line.referrer) ? null : text(line.referrer, "referrer");
  const recommendedBy = line.recommended_by == null ? null : text(line.recommended_by, "recommended_by");
  const recommender = blank(line.recommender_model_name)
    ? null
    : text(line.recommender_model_name, "recommender_model_name");
  if (line.was_product_recommended === true) handBack("a recommended product");
  const locale = blank(params.locale) ? null : text(params.locale, "locale");

  let flags = PurchaseFlags.set(0n, "is_part_of_combined_charge", true);
  const preDiscountUnitPrice = link.customizable_price && submittedTotal !== null ? submittedTotal : null;
  const attributes = {
    seller_id: link.user_id,
    link_id: link.id,
    email,
    price_cents: 0,
    displayed_price_cents: 0,
    displayed_price_currency_type: "usd",
    rate_converted_to_usd: "1.0",
    purchaser_id: purchaser?.id ?? null,
    purchaser_type: "User",
    session_id: req.sessionId,
    ip_address: req.ip,
    ip_country: geo?.countryName ?? null,
    ip_state: geo?.regionName ?? null,
    is_mobile: req.isMobile,
    can_contact: true,
    referrer,
    webhook_failed: false,
    failed: false,
    purchase_state: "in_progress",
    browser_guid: req.browserGuid,
    flags,
    tax_cents: 0,
    affiliate_credit_cents: 0,
    json_data: jsonDataOf(locale, perceived, recommender, preDiscountUnitPrice),
    total_transaction_cents: 0,
    gumroad_tax_cents: 0,
    quantity: 1,
    shipping_cents: 0,
    processor_fee_cents_currency: "usd",
    stripe_partially_refunded: false,
    recommended_by: recommendedBy,
    fee_cents: 0,
    full_name: blank(billingFields.full_name) ? null : text(billingFields.full_name, "full name"),
    street_address: blank(billingFields.street_address) ? null : text(billingFields.street_address, "street address"),
    city: blank(billingFields.city) ? null : text(billingFields.city, "city"),
    state: blank(billingFields.state) ? null : text(billingFields.state, "state"),
    zip_code: blank(billingFields.zip_code) ? null : text(billingFields.zip_code, "zip code"),
  };
  flags = attributes.flags;
  const context: PurchaseContext = {
    link,
    seller,
    geoInfo: geo ? { countryCode: geo.countryCode, regionName: geo.regionName, postalCode: geo.postalCode } : null,
    refundPolicy,
    buyerByEmail,
    buyerLookupEmail: email,
    purchaserEmail: purchaser?.email ?? undefined,
    chargeReceipt: true,
    urlParameters: null,
    effects,
  };
  const purchase = withContext(Purchases.build(attributes as never), context);
  return { purchase, context, purchaser, elected: params.tax_country_election, email };
}

// Order::CreateService and Purchase::CreateService
async function createOrderAndPurchase(req: FreeOrderRequest, link: Link, seller: User, effects: CheckoutEffects) {
  const options = { now: req.now };
  // compute_discount_allocations
  await selectRows(
    Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${link.unique_permalink}`,
  );
  // The line's `Link.find_by` comes out of the query cache
  await findLinkByPermalink(String(link.unique_permalink));

  const { purchase, context, purchaser, elected } = await buildPurchase(req, link, seller, effects);
  assertFreeCheckoutPurchase(purchase, context);

  // prepare_for_charge! -> process_without_charging!
  if (!(await Purchases.save(purchase, options))) {
    if (purchase.persisted) throw new Error("A free purchase failed validation after it was written");
    throw new NotPortedError("A free order whose purchase fails validation", "app/models/purchase.rb");
  }
  const existingTaxInfo = await selectRows(
    Prisma.sql`SELECT ${star("purchase_sales_tax_infos")} FROM ${table("purchase_sales_tax_infos")} WHERE ${column("purchase_sales_tax_infos", "purchase_id")} = ${purchase.get("id")} LIMIT 1`,
  );
  if (existingTaxInfo.length > 0) throw new Error("A new purchase already has sales tax info");
  await PurchaseSalesTaxInfos.createBang(
    {
      purchase_id: purchase.get("id"),
      elected_country_code: elected == null ? null : String(elected),
      card_country_code: null,
      ip_country_code: null,
      country_code: null,
      postal_code: null,
      ip_address: req.ip,
      business_vat_id: null,
      state_code: null,
    } as never,
    options,
  );
  await Purchases.save(purchase, options);
  // check_for_blocked_customer_emails: blockable_emails_if_fraudulent_transaction is the purchase email
  const blocked = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("blocked_customer_objects")} WHERE ${column("blocked_customer_objects", "blocked_at")} IS NOT NULL AND ${column("blocked_customer_objects", "object_type")} = ${"email"} AND ${column("blocked_customer_objects", "seller_id")} = ${link.user_id} AND ${column("blocked_customer_objects", "object_value")} = ${purchase.get("email")} LIMIT 1`,
  );
  if (blocked.length > 0) throw new NotPortedError("A free order from a blocked email", "app/models/purchase.rb");

  // order.purchases << purchase; order.save!
  const order = Orders.build({
    purchaser_id: req.buyer?.id ?? null,
    flags: 0,
    review_reminder_scheduled_at: null,
  } as never);
  order.ivars.appendedPurchases = [purchase];
  await transaction(async () => {
    await Orders.saveBang(order, options);
  });
  context.orderId = order.get("id");
  // Cart.fetch_by
  const carts = req.buyer
    ? await selectRows(
        Prisma.sql`SELECT ${star("carts")} FROM ${table("carts")} WHERE ${column("carts", "user_id")} = ${req.buyer.id} AND ${column("carts", "deleted_at")} IS NULL ORDER BY ${column("carts", "id")} ASC LIMIT 1`,
      )
    : req.browserGuid
      ? await selectRows(
          Prisma.sql`SELECT ${star("carts")} FROM ${table("carts")} WHERE ${column("carts", "deleted_at")} IS NULL AND ${column("carts", "browser_guid")} = ${req.browserGuid} AND ${column("carts", "user_id")} IS NULL LIMIT 1`,
        )
      : [];
  if (carts.length > 0)
    throw new NotPortedError("A free order from a buyer with a cart", "app/services/order/create_service.rb");
  return { purchase, context, order, purchaser };
}

// Order::ChargeService for a purchase that needs no charge: the charge row, the link to it, the transition.
async function chargeFreeOrder(
  req: FreeOrderRequest,
  link: Link,
  seller: User,
  purchaser: User | null,
  purchase: PurchaseRecord,
  order: OrderRecord,
) {
  const options = { now: req.now };
  // order.purchases.non_free.pluck(:seller_id)
  await selectRows(
    Prisma.sql`SELECT ${column("purchases", "seller_id")} FROM ${table("purchases")} INNER JOIN ${table("order_purchases")} ON ${column("purchases", "id")} = ${column("order_purchases", "purchase_id")} WHERE ${column("order_purchases", "order_id")} = ${order.get("id")} AND (purchases.price_cents != 0)`,
  );
  // purchase.processor_payment_intent
  const intents = await selectRows(
    Prisma.sql`SELECT ${star("processor_payment_intents")} FROM ${table("processor_payment_intents")} WHERE ${column("processor_payment_intents", "purchase_id")} = ${purchase.get("id")} LIMIT 1`,
  );
  if (intents.length > 0)
    throw new NotPortedError("A free order with a payment intent", "app/services/order/charge_service.rb");

  const charge = Charges.build({
    order_id: order.get("id"),
    seller_id: seller.id,
    processor: null,
    processor_transaction_id: null,
    payment_method_fingerprint: null,
    credit_card_id: null,
    merchant_account_id: null,
    amount_cents: null,
    gumroad_amount_cents: null,
    processor_fee_cents: null,
    processor_fee_currency: null,
    paypal_order_id: null,
    stripe_payment_intent_id: null,
    stripe_setup_intent_id: null,
    disputed_at: null,
    dispute_reversed_at: null,
    flags: 0,
  } as never);
  // `order.charges.create!` hands the charge its order; the seller is loaded by the presence check
  setAssociation(charge, "order", order.get("id"), order.attributes as never);
  await Charges.saveBang(charge, options);
  // purchase.charge = charge; purchase.save!
  const chargePurchases = await selectRows(
    Prisma.sql`SELECT ${star("charge_purchases")} FROM ${table("charge_purchases")} WHERE ${column("charge_purchases", "purchase_id")} = ${purchase.get("id")} LIMIT 1`,
  );
  if (chargePurchases.length > 0) throw new Error("A new purchase already has a charge");
  const chargePurchase = ChargePurchases.build({
    charge_id: charge.get("id"),
    purchase_id: purchase.get("id"),
  } as never);
  setAssociation(chargePurchase, "charge", charge.get("id"), charge.attributes as never);
  setAssociation(chargePurchase, "purchase", purchase.get("id"), purchase.attributes as never);
  await ChargePurchases.saveBang(chargePurchase, options);
  await Purchases.saveBang(purchase, options);
  const marked = await markFreePurchaseSuccessful(purchase, options);
  // ensure_all_purchases_processed builds the line's response from these reads
  const facts = await loadPurchaseResponseFacts({
    purchase: purchase.attributes as Purchase,
    link,
    seller,
    purchaser,
    urlRedirect: marked.urlRedirect,
  });
  return { charge, urlRedirect: marked.urlRedirect, facts };
}

// OrdersController#attribute_utm_link_sale
async function attributeUtmLinkSale(req: FreeOrderRequest, order: OrderRecord) {
  const successful = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} INNER JOIN ${table("order_purchases")} ON ${column("purchases", "id")} = ${column("order_purchases", "purchase_id")} WHERE ${column("order_purchases", "order_id")} = ${order.get("id")} AND ${column("purchases", "purchase_state")} = ${"successful"} LIMIT 1`,
  );
  if (successful.length === 0) return;
  const visits = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("utm_link_visits")} WHERE ${column("utm_link_visits", "browser_guid")} = ${req.browserGuid} LIMIT 1`,
  );
  if (visits.length > 0) await performAsync("UtmLinkSaleAttributionJob", [order.get("id"), req.browserGuid] as never);
}

// Events#create_purchase_event for the order's purchases (`order.purchases.each`)
async function recordPurchaseEvents(req: FreeOrderRequest, order: OrderRecord) {
  const purchases = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star("purchases")} FROM ${table("purchases")} INNER JOIN ${table("order_purchases")} ON ${column("purchases", "id")} = ${column("order_purchases", "purchase_id")} WHERE ${column("order_purchases", "order_id")} = ${order.get("id")}`,
  );
  for (const row of purchases) {
    const purchase = castRow<Purchase>("Purchase", row);
    if (PurchaseFlags.isSet(purchase.flags, "was_product_recommended")) handBack("a recommended product");
    const link = await findOne<Link>("links", Prisma.sql`${column("links", "id")} = ${purchase.link_id}`, "Link");
    const geo = geoIpLookup(req.ip);
    const requestReferrer = purchase.referrer ?? req.referer;
    const cleaned =
      requestReferrer == null
        ? null
        : // eslint-disable-next-line no-control-regex
          requestReferrer.replaceAll(/[^\x00-\x7F]/gu, "").slice(0, EVENT_REFERRER_LENGTH) || null;
    const plugins = blank(req.params.plugins) ? null : String(req.params.plugins);
    const friend = blank(req.params.friend) ? null : String(req.params.friend);
    await Events.createBang(
      {
        visit_id: 0,
        ip_address: req.ip,
        event_name: "purchase",
        user_id: null,
        link_id: link?.id ?? purchase.link_id,
        referrer: purchase.referrer,
        parent_referrer: null,
        language: req.acceptLanguage,
        browser: req.userAgent,
        is_mobile: req.isMobile,
        email: null,
        purchase_id: purchase.id,
        price_cents: purchase.price_cents,
        credit_card_id: null,
        card_type: purchase.card_type,
        card_visual: purchase.card_visual,
        purchase_state: purchase.purchase_state,
        billing_zip: purchase.zip_code,
        chargeback: false,
        refunded: false,
        view_url: req.pathInfo,
        fingerprint: null,
        ip_country: geo?.countryName ?? null,
        // Float columns: quoted as Ruby prints them (0.0)
        ip_longitude: new Prisma.Decimal(0),
        ip_latitude: new Prisma.Decimal(0),
        is_modal: null,
        friend_actions: friend,
        browser_fingerprint: createHash("md5")
          .update([req.userAgent ?? "", plugins ?? ""].join(","))
          .digest("hex"),
        browser_plugins: plugins,
        browser_guid: req.browserGuid,
        referrer_domain: referrerDomain(cleaned),
        ip_state: geo?.regionName ?? null,
        active_test_path_assignments: null,
        service_charge_id: null,
      } as never,
      { now: req.now },
    );
  }
}

// Referrer.extract_domain
function referrerDomain(referrer: string | null): string | null {
  if (referrer === null) return null;
  if (referrer === "direct") return "direct";
  try {
    return new URL(referrer).host || null;
  } catch {
    return null;
  }
}

// Order#send_charge_receipts
async function sendChargeReceipts(order: OrderRecord) {
  const charges = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star("charges")} FROM ${table("charges")} WHERE ${column("charges", "order_id")} = ${order.get("id")}`,
  );
  for (const charge of charges) {
    const successful = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} INNER JOIN ${table("charge_purchases")} ON ${column("purchases", "id")} = ${column("charge_purchases", "purchase_id")} WHERE ${column("charge_purchases", "charge_id")} = ${charge.id as bigint} AND ${column("purchases", "purchase_state")} IN (${Prisma.join(["preorder_authorization_successful", "successful", "not_charged", "gift_receiver_purchase_successful", "test_successful"], ", ")}) LIMIT 1`,
    );
    if (successful.length === 0) continue;
    // Charge#receipt_sent?
    if ((BigInt(charge.flags as bigint | number) & 1n) === 1n) continue;
    await performAsync("SendChargeReceiptJob", [charge.id as bigint] as never);
  }
}

// OrdersController#can_buyer_sign_up: `!logged_in_user && User.alive.where(email:).none?`
async function canBuyerSignUp(req: FreeOrderRequest): Promise<boolean> {
  if (req.buyer) return false;
  const email = blank(req.params.email) ? null : String(req.params.email);
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("users")} WHERE ${column("users", "deleted_at")} IS NULL AND ${email === null ? Prisma.sql`${column("users", "email")} IS NULL` : Prisma.sql`${column("users", "email")} = ${email}`} LIMIT 1`,
  );
  return rows.length === 0;
}

export async function createFreeOrder(req: FreeOrderRequest): Promise<FreeOrderResult & { canBuyerSignUp: boolean }> {
  const effects = req.effects ?? defaultCheckoutEffects;
  const permalink = text(req.line.permalink, "permalink");
  if (permalink === null) return handBack("no permalink");
  // fetch_affiliates and skip_recaptcha? load the product and its seller before the service runs
  const link = await findLinkByPermalink(permalink);
  if (!link) return handBack("an unknown product");
  const seller = link.user_id === null ? null : await findUserById(link.user_id);
  if (!seller) return handBack("a product without a seller");

  const { purchase, order, purchaser } = await createOrderAndPurchase(req, link, seller, effects);
  const { charge, urlRedirect, facts } = await chargeFreeOrder(req, link, seller, purchaser, purchase, order);
  await attributeUtmLinkSale(req, order);
  await recordPurchaseEvents(req, order);
  await sendChargeReceipts(order);
  const signUp = await canBuyerSignUp(req);
  return {
    order: { id: order.get("id") },
    purchase,
    link,
    seller,
    purchaser,
    charge: { id: charge.get("id") },
    urlRedirect,
    facts,
    canBuyerSignUp: signUp,
  };
}
