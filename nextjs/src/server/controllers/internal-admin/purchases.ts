// Api::Internal::Admin::PurchasesController: #show, #search and #lookup, the reads, plus the helpers the writes in ./purchase-writes.ts
// share. A purchase charged through Stripe hands back (Radar::ChargeRiskLevelService asks Stripe for its risk level), as does a card
// search (an index-friendly AdminSearchService filter group Node does not carry).
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { decryptNumeric, decrypt, encrypt, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { rubyStrip } from "../../content-moderation/ruby.ts";
import { domainConfig } from "../../infra/domain.ts";
import { alpha2ByName } from "../../models/compliance-countries.ts";
import { usdCentsToCurrency } from "../../models/concerns/currency-helper.ts";
import { pingDeliveryOutcome, PING_DELIVERY_MAX_RECENT } from "../../models/ping-delivery.ts";
import { cgiEscape, purchasesAsJsonV2 } from "../../models/purchase-json.ts";
import { selectRows } from "../../models/sql.ts";
import { purchaseFlagScope } from "../../models/subscription.ts";
import { NotPortedError } from "../../models/user.ts";

import { failure, isBlank, jsonRendered, paramToS, timeJson, type AdminRequest } from "./base.ts";
import { paginateWithCursor } from "./cursor.ts";
import { defineAdminRoute } from "./registry.ts";

export const SOURCE = "app/controllers/api/internal/admin/purchases_controller.rb";
const MAX_SEARCH_RESULTS = 25;
const VALID_PURCHASE_STATUSES = ["successful", "failed", "not_charged", "chargeback", "refunded"];
const LOOKUP_FIELDS = ["stripe_fingerprint", "browser_guid", "ip_address"] as const;
// ChargeProcessor.charge_processor_ids
const CHARGE_PROCESSOR_IDS = ["stripe", "braintree", "paypal"];
const TERMINAL_REFUND_STATUSES = ["failed", "canceled"];
const PAYPAL_CARD_TYPE = "paypal";
// AdminSearchService filters that need the card index; Node does not serve them.
const CARD_SEARCH_PARAMS = ["purchase_date", "card_last4", "card_type", "charge_amount", "expiry_date"];
const SEARCH_PARAMS = [
  "query",
  "email",
  "product_title_query",
  "purchase_status",
  "creator_email",
  "license_key",
  ...CARD_SEARCH_PARAMS,
];

export type PurchaseRow = {
  id: bigint;
  seller_id: bigint | null;
  link_id: bigint | null;
  created_at: Date | null;
  email: string | null;
  price_cents: number | null;
  displayed_price_currency_type: string | null;
  rate_converted_to_usd: string | null;
  purchase_state: string | null;
  stripe_refunded: number | boolean | null;
  stripe_partially_refunded: number | boolean | null;
  stripe_transaction_id: string | null;
  stripe_fingerprint: string | null;
  charge_processor_id: string | null;
  paypal_order_id: string | null;
  chargeback_date: Date | null;
  ip_address: string | null;
  ip_country: string | null;
  country: string | null;
  card_country: string | null;
  card_bin: string | null;
  card_type: string | null;
  card_visual: string | null;
  card_expiry_month: number | null;
  card_expiry_year: number | null;
  browser_guid: string | null;
  subscription_id: bigint | null;
};

type RefundRow = {
  id: bigint;
  purchase_id: bigint;
  amount_cents: number | null;
  status: string | null;
  json_data: string | null;
  created_at: Date;
};

// ActiveRecord's boolean read of a tinyint column
export const truthy = (value: unknown): boolean =>
  value === true || (typeof value === "number" && value !== 0) || (typeof value === "bigint" && value !== 0n);

// params[:x].to_s.strip
export const strippedParam = (value: unknown): string => rubyStrip(paramToS(value, SOURCE));

// Refund#effective?: a failed or canceled refund counts unless its balance debits were reversed.
function isEffectiveRefund(refund: Pick<RefundRow, "status" | "json_data">): boolean {
  if (refund.status === null || !TERMINAL_REFUND_STATUSES.includes(refund.status)) return true;
  if (refund.json_data === null || isBlank(refund.json_data)) return true;
  try {
    return (JSON.parse(refund.json_data) as Record<string, unknown>).balance_reversed_on_failure !== true;
  } catch {
    throw new NotPortedError("a refund whose json_data is not JSON", SOURCE);
  }
}

// Purchase#amount_refunded_cents: the effective refunds, summed.
async function effectiveRefundedCents(purchaseId: bigint): Promise<number> {
  const refunds = await selectRows<RefundRow>(
    Prisma.sql`SELECT id, purchase_id, amount_cents, status, json_data, created_at FROM refunds WHERE purchase_id = ${purchaseId}`,
  );
  return refunds.filter(isEffectiveRefund).reduce((sum, refund) => sum + (refund.amount_cents ?? 0), 0);
}

// Purchase#amount_refundable_cents
export async function amountRefundableCents(purchase: PurchaseRow): Promise<number> {
  if (purchase.charge_processor_id === null || !CHARGE_PROCESSOR_IDS.includes(purchase.charge_processor_id)) return 0;
  return (purchase.price_cents ?? 0) - (await effectiveRefundedCents(purchase.id));
}

// fetch_purchase: a numeric id is the purchase's encrypted numeric external id.
export async function fetchPurchase(rawId: unknown): Promise<PurchaseRow | null> {
  const text = paramToS(rawId, SOURCE);
  if (!/^\d+$/u.test(text)) return null;
  const encrypted = Number(text);
  if (!Number.isSafeInteger(encrypted)) throw new NotPortedError("a numeric purchase id past 2**53", SOURCE);
  const [row] = await selectRows<PurchaseRow>(
    Prisma.sql`SELECT * FROM purchases WHERE id = ${decryptNumeric(encrypted)} LIMIT 1`,
  );
  return row ?? null;
}

export const purchaseTarget = (purchase: PurchaseRow) => ({
  type: "Purchase",
  id: purchase.id,
  externalId: encrypt(purchase.id),
});

export const PURCHASE_NOT_FOUND = () => failure("Purchase not found", 404);

// Purchase#stripe_transaction_id.present? with the Stripe charge processor: the only purchases Radar::ChargeRiskLevelService reads.
function needsStripeRiskLevel(purchase: PurchaseRow): boolean {
  return !isBlank(purchase.stripe_transaction_id) && purchase.charge_processor_id === "stripe";
}

const latest = <Item extends { created_at: Date | null }>(items: Item[]): Item | undefined => {
  let found: Item | undefined;
  for (const item of items)
    if (
      found === undefined ||
      (item.created_at !== null && found.created_at !== null && item.created_at.getTime() > found.created_at.getTime())
    )
      found = item;
  return found;
};

// normalize_country_to_alpha2
function normalizeCountry(value: string | null): string | null {
  if (value === null || isBlank(value)) return null;
  if ([...value].length === 2) return value.toUpperCase();
  return alpha2ByName(value) ?? value.toUpperCase();
}

const countriesDiffer = (a: string | null, b: string | null): boolean => a !== null && b !== null && a !== b;

type Related = {
  links: Map<bigint, { id: bigint; name: string | null }>;
  sellers: Map<bigint, { external_id: string | null; email: string | null; name: string | null }>;
  refunds: Map<bigint, RefundRow[]>;
  disputes: Map<bigint, Awaited<ReturnType<typeof db.dispute.findMany>>>;
  warnings: Map<bigint, Awaited<ReturnType<typeof db.earlyFraudWarning.findMany>>[number]>;
  credits: Map<bigint, Awaited<ReturnType<typeof db.affiliateCredit.findMany>>[number]>;
  affiliates: Map<number, string | null>;
};

const idsOf = (values: (bigint | number | null)[]): bigint[] => [
  ...new Set(values.filter((value): value is bigint | number => value !== null).map(BigInt)),
];

async function loadRelated(purchases: PurchaseRow[]): Promise<Related> {
  const ids = purchases.map((purchase) => purchase.id);
  const [links, sellers, refunds, disputes, warnings, credits] = await Promise.all([
    db.link.findMany({
      where: { id: { in: idsOf(purchases.map((purchase) => purchase.link_id)) } },
      select: { id: true, name: true },
    }),
    db.user.findMany({
      where: { id: { in: idsOf(purchases.map((purchase) => purchase.seller_id)) } },
      select: { id: true, external_id: true, email: true, name: true },
    }),
    selectRows<RefundRow>(
      Prisma.sql`SELECT id, purchase_id, amount_cents, status, json_data, created_at FROM refunds WHERE purchase_id IN (${Prisma.join(ids)}) ORDER BY id ASC`,
    ),
    db.dispute.findMany({ where: { purchase_id: { in: ids.map(Number) } }, orderBy: { id: "asc" } }),
    db.earlyFraudWarning.findMany({ where: { purchase_id: { in: ids } }, orderBy: { id: "asc" } }),
    db.affiliateCredit.findMany({
      where: { purchase_id: { in: ids.map(Number) }, is_direct_affiliate_credit: false },
      orderBy: { id: "asc" },
    }),
  ]);
  const affiliateUsers = await db.user.findMany({
    where: { id: { in: idsOf(credits.map((credit) => credit.affiliate_user_id)) } },
    select: { id: true, external_id: true },
  });
  const grouped = <Item>(items: Item[], key: (item: Item) => bigint | number | null): Map<bigint, Item[]> => {
    const map = new Map<bigint, Item[]>();
    for (const item of items) {
      const owner = key(item);
      if (owner !== null) map.set(BigInt(owner), [...(map.get(BigInt(owner)) ?? []), item]);
    }
    return map;
  };
  const firstOf = <Item>(items: Item[], key: (item: Item) => bigint | number | null): Map<bigint, Item> =>
    new Map([...grouped(items, key)].map(([owner, list]) => [owner, list[0]!]));
  return {
    links: new Map(links.map((link) => [link.id, link])),
    sellers: new Map(sellers.map((seller) => [seller.id, seller])),
    refunds: grouped(refunds, (refund) => refund.purchase_id),
    disputes: grouped(disputes, (dispute) => dispute.purchase_id) as Related["disputes"],
    warnings: firstOf(warnings, (warning) => warning.purchase_id),
    credits: firstOf(credits, (credit) => credit.purchase_id),
    affiliates: new Map(affiliateUsers.map((user) => [Number(user.id), user.external_id])),
  };
}

const clusterCount = async (
  column: "stripe_fingerprint" | "browser_guid" | "ip_address",
  value: string | null,
  excludeId: bigint,
): Promise<number | null> => {
  if (value === null || isBlank(value)) return null;
  const [row] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM purchases WHERE ${Prisma.raw(`\`${column}\``)} = ${value} AND id != ${excludeId}`,
  );
  return Number(row?.count ?? 0);
};

const receiptUrl = (purchase: PurchaseRow): string => {
  const { protocol, domain } = domainConfig();
  const email = purchase.email === null ? "" : `?email=${cgiEscape(purchase.email)}`;
  return `${protocol}://${domain}/purchases/${encrypt(purchase.id)}/receipt${email}`;
};

// serialize_purchases_with_risk_levels and serialize_purchase
export async function serializePurchases(
  purchases: PurchaseRow[],
  options: { withClusters?: boolean; withPingDeliveries?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  if (purchases.length === 0) return [];
  if (purchases.some(needsStripeRiskLevel)) throw new NotPortedError("a Stripe Radar risk level lookup", SOURCE);
  const related = await loadRelated(purchases);
  // formatted_total_price carries the price's recurrence, which the v2 sale JSON already renders.
  const priced = await purchasesAsJsonV2(purchases, { isFollowing: () => false });
  const result: Record<string, unknown>[] = [];
  for (const [index, purchase] of purchases.entries()) {
    const refunds = related.refunds.get(purchase.id) ?? [];
    const refundAmount = refunds.filter(isEffectiveRefund).reduce((sum, refund) => sum + (refund.amount_cents ?? 0), 0);
    const currency = purchase.displayed_price_currency_type ?? "";
    const rate = isBlank(purchase.rate_converted_to_usd) ? undefined : Number(purchase.rate_converted_to_usd);
    const refundable =
      purchase.charge_processor_id !== null && CHARGE_PROCESSOR_IDS.includes(purchase.charge_processor_id)
        ? await usdCentsToCurrency(currency, (purchase.price_cents ?? 0) - refundAmount, rate)
        : 0;
    const seller = purchase.seller_id === null ? undefined : related.sellers.get(purchase.seller_id);
    const link = purchase.link_id === null ? undefined : related.links.get(purchase.link_id);
    const billing = normalizeCountry(purchase.country);
    const ip = normalizeCountry(purchase.ip_country);
    const card = normalizeCountry(purchase.card_country);
    const dispute = latest(related.disputes.get(purchase.id) ?? []);
    const warning = related.warnings.get(purchase.id);
    const credit = related.credits.get(purchase.id);
    const refunded = truthy(purchase.stripe_refunded);
    const refundStatus = refunded
      ? "refunded"
      : truthy(purchase.stripe_partially_refunded)
        ? "partially_refunded"
        : null;
    const payload: Record<string, unknown> = {
      id: encryptNumeric(Number(purchase.id)).toString(),
      email: purchase.email,
      seller_email: seller?.email ?? null,
      seller: seller === undefined ? null : { id: seller.external_id, email: seller.email, name: seller.name },
      product_name: link?.name ?? null,
      link_name: link?.name ?? null,
      product_id: link === undefined ? null : encryptNumeric(Number(link.id)).toString(),
      formatted_total_price: priced[index]!.formatted_total_price,
      price_cents: purchase.price_cents,
      currency_type: currency,
      amount_refundable_cents_in_currency: refundable,
      purchase_state: purchase.purchase_state,
      refund_status: refundStatus,
      chargeback_date: timeJson(purchase.chargeback_date),
      created_at: timeJson(purchase.created_at),
      receipt_url: receiptUrl(purchase),
      charge_processor: purchase.charge_processor_id,
      paypal_order_id: purchase.paypal_order_id,
      ip_address: purchase.ip_address,
      ip_country: purchase.ip_country,
      billing_country: purchase.country,
      card_country: purchase.card_country,
      country_mismatches: {
        billing_vs_ip: countriesDiffer(billing, ip),
        billing_vs_card: countriesDiffer(billing, card),
        ip_vs_card: countriesDiffer(ip, card),
      },
      card: {
        bin: purchase.card_bin,
        type: purchase.card_type,
        visual: purchase.card_visual,
        expiry_month: purchase.card_expiry_month,
        expiry_year: purchase.card_expiry_year,
      },
      dispute:
        dispute === undefined
          ? null
          : {
              id: encrypt(dispute.id),
              state: dispute.state,
              reason: dispute.reason,
              charge_processor_dispute_id: dispute.charge_processor_dispute_id,
              created_at: timeJson(dispute.created_at),
              initiated_at: timeJson(dispute.initiated_at),
              formalized_at: timeJson(dispute.formalized_at),
              won_at: timeJson(dispute.won_at),
              lost_at: timeJson(dispute.lost_at),
            },
      early_fraud_warning:
        warning === undefined
          ? null
          : {
              id: warning.id.toString(),
              processor_id: warning.processor_id,
              fraud_type: warning.fraud_type,
              charge_risk_level: warning.charge_risk_level,
              actionable: warning.actionable,
              resolution: warning.resolution,
              resolution_message: warning.resolution_message,
              resolved_at: timeJson(warning.resolved_at),
              processor_created_at: timeJson(warning.processor_created_at),
            },
      affiliate_credit:
        credit === undefined
          ? null
          : {
              amount_cents: credit.amount_cents,
              fee_cents: Number(credit.fee_cents),
              basis_points: credit.basis_points,
              affiliate_user_id:
                credit.affiliate_user_id === null ? null : (related.affiliates.get(credit.affiliate_user_id) ?? null),
            },
      stripe_risk_level: null,
    };
    if (refundAmount > 0) payload.refund_amount = refundAmount;
    if (refundStatus !== null) payload.refund_date = timeJson(latest(refunds)?.created_at);
    if (options.withClusters)
      payload.clusters = {
        fingerprint_count: await clusterCount("stripe_fingerprint", purchase.stripe_fingerprint, purchase.id),
        browser_count: await clusterCount("browser_guid", purchase.browser_guid, purchase.id),
        ip_count: await clusterCount("ip_address", purchase.ip_address, purchase.id),
      };
    if (options.withPingDeliveries) {
      const deliveries = await db.pingDelivery.findMany({
        where: { purchase_id: purchase.id },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: PING_DELIVERY_MAX_RECENT,
      });
      payload.ping_deliveries = deliveries.map((delivery) => ({
        id: Number(delivery.id),
        resource_name: delivery.resource_name,
        sale_id: encryptNumeric(Number(purchase.id)).toString(),
        subscription_id: delivery.subscription_id === null ? null : Number(delivery.subscription_id),
        post_url: delivery.post_url,
        attempt: delivery.attempt,
        outcome: pingDeliveryOutcome(delivery),
        succeeded: delivery.succeeded,
        created_at: timeJson(delivery.created_at),
      }));
    }
    result.push(payload);
  }
  return result;
}

type SearchParams = Partial<Record<(typeof SEARCH_PARAMS)[number], string>>;

// purchase_search_params: stripped strings, blanks dropped.
function searchParams(admin: AdminRequest): SearchParams {
  const found: SearchParams = {};
  for (const key of SEARCH_PARAMS) {
    const value = admin.params[key];
    if (isBlank(value)) continue;
    if (typeof value !== "string") throw new NotPortedError("a search parameter that is not a string", SOURCE);
    const stripped = rubyStrip(value);
    if (!isBlank(stripped)) found[key] = stripped;
  }
  return found;
}

// String#to_i / Integer#to_i on params[:limit]
export function searchLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return MAX_SEARCH_RESULTS;
  if (typeof raw !== "string" && typeof raw !== "number")
    throw new NotPortedError("a limit that is not a string", SOURCE);
  const requested =
    typeof raw === "number"
      ? Math.trunc(raw)
      : Number.parseInt(/^\s*([+-]?\d+(?:_\d+)*)/u.exec(raw)?.[1]?.replaceAll("_", "") ?? "0", 10);
  return requested <= 0 ? MAX_SEARCH_RESULTS : Math.min(requested, MAX_SEARCH_RESULTS);
}

// AdminSearchService#search_purchases without the card filters. Purchase.none is `null`.
async function searchConditions(
  search: SearchParams,
): Promise<{ conditions: Prisma.Sql[]; joinsLink: boolean } | null> {
  const conditions: Prisma.Sql[] = [];
  let joinsLink = false;
  if (search.email !== undefined) conditions.push(Prisma.sql`purchases.email = ${search.email}`);
  if (search.query !== undefined) {
    const query = search.query;
    const unions = [
      Prisma.sql`SELECT gifter_purchase_id AS purchase_id FROM gifts WHERE gifter_email = ${query}`,
      Prisma.sql`SELECT giftee_purchase_id AS purchase_id FROM gifts WHERE giftee_email = ${query}`,
      Prisma.sql`SELECT purchases.id AS purchase_id FROM purchases WHERE email = ${query}`,
      Prisma.sql`SELECT purchases.id AS purchase_id FROM purchases WHERE card_visual = ${query} AND card_type = ${PAYPAL_CARD_TYPE}`,
      Prisma.sql`SELECT purchases.id AS purchase_id FROM purchases WHERE stripe_fingerprint = ${query}`,
      Prisma.sql`SELECT purchases.id AS purchase_id FROM purchases WHERE ip_address = ${query}`,
    ];
    // Purchase.from_external_id is truthy for any decrypted value, 0 included.
    const external = decrypt(query);
    if (external !== null)
      unions.push(Prisma.sql`SELECT purchases.id AS purchase_id FROM purchases WHERE id = ${external}`);
    // !Purchase.external_id?(query): the query is the digits of its own to_i.
    if (/^-?(?:0|[1-9]\d*)$/u.test(query))
      unions.push(Prisma.sql`SELECT purchases.id AS purchase_id FROM purchases WHERE id = ${BigInt(query)}`);
    conditions.push(
      Prisma.sql`purchases.id IN (SELECT purchase_id FROM (${Prisma.join(
        unions.map((union) => Prisma.sql`(${union})`),
        " UNION ",
      )}) via_gifts_and_purchases)`,
    );
    if (search.product_title_query !== undefined) {
      joinsLink = true;
      conditions.push(Prisma.sql`links.name LIKE ${`%${search.product_title_query}%`}`);
    }
    switch (search.purchase_status) {
      case "successful":
      case "failed":
      case "not_charged":
        conditions.push(Prisma.sql`purchases.purchase_state = ${search.purchase_status}`);
        break;
      case "chargeback":
        conditions.push(
          Prisma.sql`purchases.chargeback_date IS NOT NULL AND ${purchaseFlagScope("chargeback_reversed", false)}`,
        );
        break;
      case "refunded":
        conditions.push(Prisma.sql`purchases.stripe_refunded = ${true}`);
        break;
    }
  }
  if (search.creator_email !== undefined) {
    const user = await db.user.findFirst({
      where: { email: search.creator_email },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (user === null) return null;
    joinsLink = true;
    conditions.push(Prisma.sql`links.user_id = ${user.id}`);
  }
  if (search.license_key !== undefined) {
    const license = await db.license.findFirst({
      where: { serial: search.license_key },
      orderBy: { id: "asc" },
      select: { purchase_id: true },
    });
    if (license === null) return null;
    conditions.push(Prisma.sql`purchases.id = ${license.purchase_id}`);
  }
  return { conditions, joinsLink };
}

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/purchases/search",
    run: async (admin) => {
      const search = searchParams(admin);
      if (
        search.query === undefined &&
        (search.product_title_query !== undefined || search.purchase_status !== undefined)
      )
        return failure("query is required when product_title_query or purchase_status is provided.", 400);
      if (Object.keys(search).length === 0) return failure("At least one search parameter is required.", 400);
      if (search.purchase_status !== undefined && !VALID_PURCHASE_STATUSES.includes(search.purchase_status)) {
        return failure(
          `purchase_status must be one of: ${VALID_PURCHASE_STATUSES.slice(0, -1).join(", ")}, or ${VALID_PURCHASE_STATUSES.at(-1)}.`,
          400,
        );
      }
      if (CARD_SEARCH_PARAMS.some((key) => key in search)) throw new NotPortedError("a card search", SOURCE);

      const limit = searchLimit(admin.params.limit);
      const found = await searchConditions(search);
      const where =
        found === null || found.conditions.length === 0 ? Prisma.sql`1 = 1` : Prisma.join(found.conditions, " AND ");
      const rows =
        found === null
          ? []
          : await selectRows<PurchaseRow>(
              Prisma.sql`SELECT purchases.* FROM purchases ${found.joinsLink ? Prisma.sql`INNER JOIN links ON links.id = purchases.link_id` : Prisma.empty} WHERE ${where} ORDER BY purchases.created_at DESC LIMIT ${limit + 1}`,
            );
      return jsonRendered({
        success: true,
        purchases: await serializePurchases(rows.slice(0, limit)),
        count: Math.min(rows.length, limit),
        limit,
        has_more: rows.length > limit,
      });
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/purchases/lookup",
    run: async (admin) => {
      const present = LOOKUP_FIELDS.filter((field) => !isBlank(strippedParam(admin.params[field])));
      if (present.length === 0) return failure("stripe_fingerprint, browser_guid, or ip_address is required", 400);
      if (present.length > 1)
        return failure("only one of stripe_fingerprint, browser_guid, ip_address is allowed", 400);
      const field = present[0]!;
      const value = strippedParam(admin.params[field]);
      const page = await paginateWithCursor<PurchaseRow & { created_at_iso: string }>(
        "purchases",
        Prisma.sql`\`purchases\`.${Prisma.raw(`\`${field}\``)} = ${value}`,
        admin.params,
        Prisma.raw("`purchases`.*"),
      );
      if ("invalid" in page) return page.invalid;
      return jsonRendered({
        success: true,
        lookup: { field, value },
        purchases: await serializePurchases(page.rows),
        pagination: page.pagination,
      });
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/purchases/:id",
    run: async (admin) => {
      const purchase = await fetchPurchase(admin.params.id);
      if (purchase === null) return PURCHASE_NOT_FOUND();
      const [serialized] = await serializePurchases([purchase], { withClusters: true, withPingDeliveries: true });
      return jsonRendered({ success: true, purchase: serialized });
    },
  },
);
