// CreatorHomePresenter#creator_home_props (app/presenters/creator_home_presenter.rb) for GET /dashboard.
//
// Handed back to Rails (HandBackToRails) for what the port does not read: a product card whose product has an alive
// thumbnail (Active Storage URL), a Stripe compliance request whose verification error needs the P.O. Box check, a
// seller whose payout destination is a Stripe or PayPal Connect account, and a seller whose balance stats are
// cached (a large seller past the caching threshold).
import { Prisma, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { indexName } from "../../infra/elasticsearch.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { formattedDollarAmount } from "../../models/concerns/currency-helper.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "../../models/merchant-account.ts";
import type { SocialConnection } from "../../models/social-connect-funnel.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { overviewStats } from "../../models/user-balance-stats.ts";
import { aliveUserComplianceInfoRow, jsonAttr } from "../../models/user-compliance-info.ts";
import { UserFlags } from "../../models/user.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { requireUser, roleOwnerFor } from "../../policies/seller-context.ts";
import { count } from "../../search/api.ts";
import { addDays } from "../../search/civil-time.ts";
import { CHARGED_SALES_SEARCH_OPTIONS, CreatorAnalyticsSales } from "../../search/creator-analytics-sales.ts";
import { InstallmentFlags, PurchaseFlags } from "../../search/flags.ts";
import { followerEventSources } from "../../search/following.ts";
import { aggregationValue, type Aggregations } from "../../search/purchase-sales.ts";
import { PurchaseSearchService } from "../../search/purchase-search.ts";
import { productsForCreatorAnalytics, sellerToday } from "../analytics/seller-analytics.ts";
import { taxCenterEnabled } from "../dashboard/tax-center.ts";
import { NotPortedError } from "../not-ported.ts";
import { balanceStatsCacheApplies } from "../payouts/payouts.ts";
import { verificationErrorMessage } from "../settings/verification-error-message.ts";
import { activeBankAccount } from "../signed-in/reads.ts";

export const ACTIVITY_ITEMS_LIMIT = 10;
export const BALANCE_ITEMS_LIMIT = 3;
// The best-seller card covers today and this many days before it.
export const SALES_LOOKBACK_DAYS = 30;
export const LAST_WEEK_DAYS = 7;

// Purchase::NON_GIFT_SUCCESS_STATES
const NON_GIFT_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged"];
// Purchase::ACTIVE_SALES_SEARCH_OPTIONS
const ACTIVE_SALES_SEARCH_OPTIONS = {
  state: NON_GIFT_SUCCESS_STATES,
  exclude_refunded_except_subscriptions: true,
  exclude_unreversed_chargedback: true,
  exclude_non_original_subscription_purchases: true,
  exclude_deactivated_subscriptions: true,
  exclude_bundle_product_purchases: true,
  exclude_commission_completion_purchases: true,
};

const CHARGED_SUCCESS_STATES = ["preorder_authorization_successful", "successful"];
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

const exists = async (statement: Prisma.Sql) => (await selectRows(statement)).length > 0;
const flag = (seller: User, name: Parameters<typeof UserFlags.isSet>[1]) => UserFlags.isSet(seller.flags, name);

export type CreatorHome = Record<string, unknown> & { social_connections?: SocialConnection[] };

async function hasPayoutInformation(seller: User): Promise<boolean> {
  if (await activeBankAccount(seller.id)) return true;
  if (present(seller.payment_address)) return true;
  // has_stripe_account_connected? / has_paypal_account_connected? read Connect and PayPal merchant accounts.
  const stripe = await aliveStripeAccountsOf(seller.id);
  const paypal = await exists(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} AND ${column("merchant_accounts", "charge_processor_id")} = 'paypal' LIMIT 1`,
  );
  if (stripe.some(isStripeConnectAccount) || paypal) throw new HandBackToRails();
  return false;
}

async function gettingStartedStats(seller: User, firstProduct: boolean, hasSale: boolean, dismissed: boolean) {
  if (dismissed) return { first_product: firstProduct };
  return {
    customized_profile: present(seller.name),
    first_follower: await exists(
      Prisma.sql`SELECT 1 FROM ${table("followers")} WHERE ${column("followers", "followed_id")} = ${seller.id} LIMIT 1`,
    ),
    first_product: firstProduct,
    first_sale: hasSale,
    first_payout: await hasPayoutInformation(seller),
    first_email: await exists(
      Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${seller.id} AND ${column("installments", "workflow_id")} IS NULL AND ${InstallmentFlags.condition("send_emails", true)} LIMIT 1`,
    ),
    used_cli: flag(seller, "has_used_cli"),
  };
}

// User#should_be_shown_currencies_always?
async function showCurrenciesAlways(seller: User): Promise<boolean> {
  if (seller.currency_type !== "usd") return true;
  const [payment] = await selectRows<{ currency: string | null }>(
    Prisma.sql`SELECT ${column("payments", "currency")} FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${seller.id} ORDER BY ${column("payments", "id")} DESC LIMIT 1`,
  );
  return payment !== undefined && payment.currency !== null && payment.currency !== "usd";
}

type ProductCard = {
  id: string;
  name: string | null;
  thumbnail: string | null;
  sales: number;
  revenue: number;
  visits: number;
  today: number;
  last_7: number;
  last_30: number;
};

async function productCard(
  product: { id: bigint; name: string | null; unique_permalink: string | null },
  dailyTotals: number[],
): Promise<ProductCard> {
  const productId = Number(product.id);
  const sales = (
    await PurchaseSearchService.process({
      ...ACTIVE_SALES_SEARCH_OPTIONS,
      product: productId,
      size: 0,
      track_total_hits: true,
    })
  ).total;
  const revenueResult = await PurchaseSearchService.process({
    ...CHARGED_SALES_SEARCH_OPTIONS,
    product: productId,
    size: 0,
    aggs: {
      price_cents_total: { sum: { field: "price_cents" } },
      amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
    },
  });
  const aggregations = revenueResult.response.aggregations as Aggregations;
  const revenue =
    aggregationValue(aggregations.price_cents_total?.value, "price_cents_total") -
    aggregationValue(aggregations.amount_refunded_cents_total?.value, "amount_refunded_cents_total");
  const views = (
    await count({ index: indexName("ProductPageView"), body: { query: { term: { product_id: productId } } } })
  ).body as { count: number };
  return {
    id: product.unique_permalink!,
    name: product.name,
    thumbnail: null,
    sales: sales ?? 0,
    revenue,
    visits: views.count,
    today: dailyTotals.at(-1)!,
    last_7: dailyTotals.slice(-LAST_WEEK_DAYS).reduce((sum, value) => sum + value, 0),
    last_30: dailyTotals.reduce((sum, value) => sum + value, 0),
  };
}

type LinkSummary = {
  id: bigint;
  name: string | null;
  unique_permalink: string | null;
  purchase_disabled_at: Date | null;
  banned_at: Date | null;
  deleted_at: Date | null;
};

async function bestSellingProducts(seller: User, now: Date): Promise<ProductCard[]> {
  const today = sellerToday(seller, now);
  const dates = Array.from({ length: SALES_LOOKBACK_DAYS + 1 }, (_, index) =>
    addDays(today, index - SALES_LOOKBACK_DAYS),
  );
  const daysByProduct = new Map<number, Map<string, { count: number; total: number }>>();
  for (const { key, value } of await new CreatorAnalyticsSales(seller, dates).byProductAndDate()) {
    const [productId, date] = key;
    if (!daysByProduct.has(productId)) daysByProduct.set(productId, new Map());
    daysByProduct.get(productId)!.set(date, value);
  }

  // Ties go to the newest product.
  const sold = (days: Map<string, { count: number }>) => [...days.values()].reduce((sum, day) => sum + day.count, 0);
  let rankedIds = [...daysByProduct.entries()]
    .sort(([idA, daysA], [idB, daysB]) => sold(daysB) - sold(daysA) || idB - idA)
    .slice(0, BALANCE_ITEMS_LIMIT)
    .map(([productId]) => productId);
  // Spare slots go to the newest products analytics lists that are alive.
  if (rankedIds.length < BALANCE_ITEMS_LIMIT) {
    const taken = new Set(rankedIds);
    const spare = (await productsForCreatorAnalytics(seller.id)).filter((product) => !taken.has(Number(product.id)));
    const alive = await selectAlive(spare.map((product) => product.id));
    rankedIds = [
      ...rankedIds,
      ...spare
        .filter((product) => alive.has(product.id))
        .slice(0, BALANCE_ITEMS_LIMIT - rankedIds.length)
        .map((product) => Number(product.id)),
    ];
  }
  if (rankedIds.length === 0) return [];

  const rows = await selectRows<LinkSummary>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")}, ${column("links", "unique_permalink")}, ${column("links", "purchase_disabled_at")}, ${column("links", "banned_at")}, ${column("links", "deleted_at")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "id")} IN (${Prisma.join(rankedIds)})`,
  );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const cards: ProductCard[] = [];
  for (const productId of rankedIds) {
    const product = byId.get(productId);
    // Link#alive?
    if (!product || product.purchase_disabled_at !== null || product.banned_at !== null || product.deleted_at !== null)
      continue;
    if (
      await exists(
        Prisma.sql`SELECT 1 FROM ${table("thumbnails")} WHERE ${column("thumbnails", "product_id")} = ${product.id} AND ${column("thumbnails", "deleted_at")} IS NULL LIMIT 1`,
      )
    )
      throw new HandBackToRails();
    const days = daysByProduct.get(productId);
    cards.push(
      await productCard(
        product,
        dates.map((date) => days?.get(date)?.total ?? 0),
      ),
    );
  }
  return cards;
}

// `.alive` on products_for_creator_analytics
async function selectAlive(ids: bigint[]): Promise<Set<bigint>> {
  if (ids.length === 0) return new Set();
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(ids)}) AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL`,
  );
  return new Set(rows.map((row) => BigInt(row.id)));
}

async function salesActivityItems(seller: User) {
  const rows = await selectRows<{
    created_at: Date;
    price_cents: number | null;
    email: string | null;
    full_name: string | null;
    product_name: string | null;
    product_unique_permalink: string | null;
  }>(
    Prisma.sql`SELECT ${column("purchases", "created_at")}, ${column("purchases", "price_cents")}, ${column("purchases", "email")}, ${column("purchases", "full_name")}, ${column("links", "name")} AS product_name, ${column("links", "unique_permalink")} AS product_unique_permalink
      FROM ${table("purchases")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("purchases", "link_id")}
      WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${column("purchases", "purchase_state")} = 'successful' AND ${PurchaseFlags.condition("is_bundle_product_purchase", false)}
      ORDER BY ${column("purchases", "created_at")} DESC LIMIT ${ACTIVITY_ITEMS_LIMIT}`,
  );
  return rows.map((sale) => ({
    type: "new_sale",
    timestamp: sale.created_at.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    details: {
      price_cents: sale.price_cents,
      email: sale.email,
      full_name: sale.full_name,
      product_name: sale.product_name,
      product_unique_permalink: sale.product_unique_permalink,
    },
  }));
}

async function followersActivityItems(seller: User) {
  const results = await followerEventSources(seller.id);
  const userIds = [
    ...new Set(results.map((result) => result.follower_user_id).filter((id): id is number => typeof id === "number")),
  ];
  const names = new Map<number, string | null>();
  if (userIds.length > 0) {
    for (const row of await selectRows<{ id: bigint; name: string | null }>(
      Prisma.sql`SELECT ${column("users", "id")}, ${column("users", "name")} FROM ${table("users")} WHERE ${column("users", "id")} IN (${Prisma.join(userIds)})`,
    )) {
      names.set(Number(row.id), row.name);
    }
  }
  return results.map((result) => ({
    type: `follower_${String(result.name)}`,
    timestamp: result.timestamp as string,
    details: {
      email: result.email ?? null,
      name: typeof result.follower_user_id === "number" ? (names.get(result.follower_user_id) ?? null) : null,
    },
  }));
}

async function activityItems(seller: User) {
  const items = [...(await followersActivityItems(seller)), ...(await salesActivityItems(seller))];
  // sort_by { timestamp } compares the strings; the last ten, newest first.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      a.item.timestamp < b.item.timestamp ? -1 : a.item.timestamp > b.item.timestamp ? 1 : a.index - b.index,
    )
    .map(({ item }) => item)
    .slice(-ACTIVITY_ITEMS_LIMIT)
    .reverse();
}

async function socialConnections(seller: User, context: SellerContext): Promise<SocialConnection[] | null> {
  if (flag(seller, "has_dismissed_getting_started_checklist")) return null;
  // Settings::ProfilePolicy#manage_social_connections? (update_username?: the owner)
  if (!roleOwnerFor(requireUser(context))) return null;
  const identity = async (name: string) =>
    exists(Prisma.sql`SELECT 1 FROM ${table(name)} WHERE ${column(name, "user_id")} = ${seller.id} LIMIT 1`);
  const actor = userActor(seller.id);
  const connections: SocialConnection[] = [{ name: "X", connected: present(seller.twitter_user_id) }];
  for (const [name, identities, feature] of [
    ["YouTube", "user_youtube_identities", "youtube_connect"],
    ["Instagram", "user_instagram_identities", "instagram_connect"],
    ["TikTok", "user_tiktok_identities", "tiktok_connect"],
  ] as const) {
    const connected = await identity(identities);
    if (connected || (await isFeatureEnabled(feature, actor))) connections.push({ name, connected });
  }
  return connections;
}

// The last requested compliance request with a message wins, as the presenter's `each` overwrites. The P.O. Box
// deadlock (address-mismatch codes) reads the seller's address history, which Node does not, so it goes to Rails.
export async function stripeVerificationMessage(seller: User): Promise<string | null> {
  const accounts = (await aliveStripeAccountsOf(seller.id)).filter((account) => !isStripeConnectAccount(account));
  if (accounts.length === 0) return null;
  const requests = await db.userComplianceInfoRequest.findMany({
    where: { user_id: Number(seller.id), state: "requested" },
    orderBy: { id: "asc" },
  });
  let message: string | null = null;
  for (const request of requests) {
    let text: string | null;
    try {
      text = verificationErrorMessage(jsonAttr({ json_data: request.json_data }, "verification_error"));
    } catch (error) {
      if (error instanceof NotPortedError) throw new HandBackToRails();
      throw error;
    }
    if (present(text)) message = text;
  }
  return message;
}

export async function creatorHomeProps(context: SellerContext, now: Date): Promise<CreatorHome> {
  const seller = context.seller!;
  // A large seller past the caching threshold reads a blob a job refreshes (UserBalanceStatsService#should_use_cache?).
  if (await balanceStatsCacheApplies(seller.id)) throw new HandBackToRails();

  const hasSale = await exists(
    Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${PurchaseFlags.condition("is_bundle_product_purchase", false)} AND ${column("purchases", "purchase_state")} IN (${Prisma.join(CHARGED_SUCCESS_STATES)}) LIMIT 1`,
  );
  const firstProduct = await exists(
    Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL LIMIT 1`,
  );
  const dismissed = flag(seller, "has_dismissed_getting_started_checklist");
  const stats = await gettingStartedStats(seller, firstProduct, hasSale, dismissed);

  const sales = await bestSellingProducts(seller, now);
  const balances = await overviewStats(seller.id, now);
  const stripeMessage = await stripeVerificationMessage(seller);

  let emailConfirmation: { email: string | null; can_resend: boolean } | null = null;
  if (present(seller.unconfirmed_email) || seller.confirmed_at === null) {
    emailConfirmation = {
      email: present(seller.unconfirmed_email) ? seller.unconfirmed_email : seller.email,
      can_resend: roleOwnerFor(requireUser(context)),
    };
  }

  // Outside the US every year is ineligible for a 1099, so the list stays empty and the notice off.
  const taxCenter = await taxCenterEnabled(seller.id);
  let taxForms: [] | Record<string, never> = {};
  let show1099 = false;
  if (taxCenter) {
    taxForms = [];
    show1099 = await exists(
      Prisma.sql`SELECT 1 FROM ${table("user_tax_forms")} WHERE ${column("user_tax_forms", "user_id")} = ${seller.id} AND ${column("user_tax_forms", "tax_year")} = ${now.getUTCFullYear() - 1} LIMIT 1`,
    );
  }

  const always = await showCurrenciesAlways(seller);
  const compliance = await aliveUserComplianceInfoRow(seller.id);
  const connections = await socialConnections(seller, context);

  return {
    name: compliance?.first_name ?? "",
    has_sale: hasSale,
    getting_started_stats: stats,
    getting_started_dismissed: dismissed,
    balances: {
      balance: formattedDollarAmount(balances.balance, { withCurrency: always }),
      last_seven_days_sales_total: formattedDollarAmount(balances.last_seven_days_sales_total, {
        withCurrency: always,
      }),
      last_28_days_sales_total: formattedDollarAmount(balances.last_28_days_sales_total, { withCurrency: always }),
      total: formattedDollarAmount(balances.sales_cents_total, { withCurrency: always }),
    },
    sales,
    activity_items: await activityItems(seller),
    stripe_verification_message: stripeMessage,
    email_confirmation: emailConfirmation,
    tax_forms: taxForms,
    show_1099_download_notice: show1099,
    tax_center_enabled: taxCenter,
    ...(connections ? { social_connections: connections } : {}),
  };
}
