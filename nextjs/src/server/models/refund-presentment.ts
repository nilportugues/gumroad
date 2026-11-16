// Purchase::PresentmentRefund (app/services/purchase/presentment_refund.rb) and Purchase#derive_presentment_refund_from_flow_of_funds
// (app/modules/purchase/refundable.rb): the buyer-currency share of a refund, from the sale's presentment row and what earlier refunds
// of it consumed. Reads only; nothing here writes. Golden: __fixtures__/refund-presentment.golden.json
// (scripts/golden/refund-presentment.rb), run by the real classes against a scratch database.
import { Prisma, type Purchase } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import type { SellerFlowOfFunds } from "./balance-transaction-amounts.ts";
import { chargeOfPurchase } from "./charge.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";
import type { PurchaseRecord } from "./purchase-create.ts";
import { externalId } from "./refund.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

// no golden has a prior refund that took more of a component than the sale holds
const OVERDRAWN_COMPONENT = "a refund that overdraws a component";

const notPorted = (what: string) =>
  new NotPortedError(`Purchase::PresentmentRefund with ${what}`, "app/services/purchase/presentment_refund.rb");

// Purchase::Refundable::BUYER_PRESENTMENT_REFUND_ERROR_MESSAGE
export const BUYER_PRESENTMENT_REFUND_ERROR_MESSAGE =
  "Refunds are temporarily unavailable for buyer-local-currency purchases.";

// Refund.effective
const EFFECTIVE = Prisma.sql`(refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled') OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')`;

// PresentmentRefund::COMPONENT_KEYS
const COMPONENT_KEYS = [
  "presentment_price_cents",
  "presentment_tip_cents",
  "presentment_seller_tax_cents",
  "presentment_gumroad_tax_cents",
  "presentment_shipping_cents",
] as const;

type PresentmentRow = Record<(typeof COMPONENT_KEYS)[number] | "presentment_total_cents", unknown> & {
  id: unknown;
  charge_presentment_id: unknown;
  presentment_currency: string;
};

// PresentmentRefund::Result#json_data, in the order Ruby builds it
export type PresentmentSnapshot = {
  presentment_currency: string;
  presentment_amount_cents: number;
  presentment_price_cents: number;
  presentment_tip_cents: number;
  presentment_seller_tax_cents: number;
  presentment_gumroad_tax_cents: number;
  presentment_shipping_cents: number;
};

export type DerivedRefund = { canonical_gross_refund_cents: number; presentment_refund: PresentmentSnapshot };

// Charge.allocate_by_largest_remainder
export function allocateByLargestRemainder(
  totalCents: number,
  weights: readonly number[],
  weightTotal: number,
): number[] {
  if (rubyToI(weightTotal) === 0) return weights.map(() => 0);

  const exactShares = weights.map((weight) => (totalCents * weight) / weightTotal);
  const floors = exactShares.map((share) => Math.floor(share));
  const residual = totalCents - floors.reduce((sum, floor) => sum + floor, 0);
  if (residual !== 0) {
    const step = residual > 0 ? 1 : -1;
    // largest remainder first when distributing, smallest first when reclaiming; ties by index
    const ranked = weights
      .map((_, index) => index)
      .sort((a, b) => {
        const left = exactShares[a]! - floors[a]!;
        const right = exactShares[b]! - floors[b]!;
        const byRemainder = residual > 0 ? right - left : left - right;
        return byRemainder !== 0 ? byRemainder : a - b;
      });
    for (const index of ranked.slice(0, Math.abs(residual))) floors[index]! += step;
  }
  return floors;
}

type EffectiveRefund = Record<string, unknown>;

// What a refund's json_data holds for `key`, read with `.to_i`
function jsonInt(refund: EffectiveRefund, key: string): number {
  const data: unknown = typeof refund.json_data === "string" ? JSON.parse(refund.json_data) : refund.json_data;
  if (data === null || typeof data !== "object") return 0;
  return rubyToI((data as Record<string, unknown>)[key]);
}

// `purchase.refunds.effective`, loaded: every call is a query
async function effectiveRefunds(purchase: PurchaseRecord): Promise<EffectiveRefund[]> {
  return selectRows<EffectiveRefund>(
    Prisma.sql`SELECT ${Prisma.raw("`refunds`.*")} FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} = ${purchase.get("id")} AND ${EFFECTIVE}`,
  );
}

// `purchase.purchase_presentment`, which the purchase keeps once loaded
const PRESENTMENT = "purchasePresentment";
async function presentmentOf(purchase: PurchaseRecord): Promise<PresentmentRow | null> {
  const memo = purchase.ivars as Record<string, Promise<PresentmentRow | null> | undefined>;
  memo[PRESENTMENT] ??= selectRows<PresentmentRow>(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_presentments`.*")} FROM ${table("purchase_presentments")} WHERE ${column("purchase_presentments", "purchase_id")} = ${purchase.get("id")} LIMIT 1`,
  ).then((rows) => rows[0] ?? null);
  return memo[PRESENTMENT];
}

// `purchase.refunds.effective.sum(:<name>)`
async function effectiveSum(purchase: PurchaseRecord, name: string): Promise<number> {
  const [row] = await selectRows(
    Prisma.sql`SELECT SUM(${column("refunds", name)}) FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} = ${purchase.get("id")} AND ${EFFECTIVE}`,
  );
  return Number(Object.values(row ?? {})[0] ?? 0);
}

// Purchase#gross_amount_refundable_cents; each call is two queries
async function grossAmountRefundableCents(purchase: PurchaseRecord): Promise<number> {
  if (purchase.get("charge_processor_id") !== "stripe") throw notPorted("a processor other than Stripe");
  const amount = purchase.get("price_cents")! - (await effectiveSum(purchase, "amount_cents"));
  return amount + ((purchase.get("gumroad_tax_cents") ?? 0) - (await effectiveSum(purchase, "gumroad_tax_cents")));
}

// `purchase.refunds.effective.sum { _1.public_send(key).to_i }`
async function refundedPresentmentCents(purchase: PurchaseRecord, key: string): Promise<number> {
  return (await effectiveRefunds(purchase)).reduce((sum, refund) => sum + jsonInt(refund, key), 0);
}

// `purchase.refunds.effective.any? { _1.presentment_amount_cents.to_i <= 0 }`
async function anyPriorWithoutSnapshot(purchase: PurchaseRecord): Promise<boolean> {
  return (await effectiveRefunds(purchase)).some((refund) => jsonInt(refund, "presentment_amount_cents") <= 0);
}

async function remainingComponentCents(purchase: PurchaseRecord, presentment: PresentmentRow): Promise<number[]> {
  const remaining: number[] = [];
  for (const key of COMPONENT_KEYS)
    remaining.push(rubyToI(presentment[key]) - (await refundedPresentmentCents(purchase, key)));
  return remaining;
}

async function remainingPresentmentAmountCents(purchase: PurchaseRecord, presentment: PresentmentRow): Promise<number> {
  return (
    rubyToI(presentment.presentment_total_cents) -
    (await refundedPresentmentCents(purchase, "presentment_amount_cents"))
  );
}

function buildResult(
  presentment: PresentmentRow,
  amountCents: number,
  components: readonly number[],
): PresentmentSnapshot {
  return {
    presentment_currency: presentment.presentment_currency,
    presentment_amount_cents: amountCents,
    presentment_price_cents: components[0]!,
    presentment_tip_cents: components[1]!,
    presentment_seller_tax_cents: components[2]!,
    presentment_gumroad_tax_cents: components[3]!,
    presentment_shipping_cents: components[4]!,
  };
}

// PresentmentRefund#result_for_presentment_amount
async function resultForPresentmentAmount(
  purchase: PurchaseRecord,
  presentment: PresentmentRow,
  amountCents: number,
): Promise<PresentmentSnapshot | null> {
  if (amountCents <= 0) return null;
  const components = await remainingComponentCents(purchase, presentment);
  if (components.some((cents) => cents < 0)) throw notPorted(OVERDRAWN_COMPONENT);
  if (amountCents === (await remainingPresentmentAmountCents(purchase, presentment)))
    return buildResult(presentment, amountCents, components);
  return buildResult(
    presentment,
    amountCents,
    allocateByLargestRemainder(amountCents, components, await remainingPresentmentAmountCents(purchase, presentment)),
  );
}

// PresentmentRefund.from_presentment_amount
export async function fromPresentmentAmount(
  purchase: PurchaseRecord,
  presentmentAmountCents: number,
): Promise<DerivedRefund | null> {
  const presentment = await presentmentOf(purchase);
  const amountCents = rubyToI(presentmentAmountCents);
  if (presentment === null || amountCents <= 0 || rubyToI(presentment.presentment_total_cents) <= 0) return null;

  const prior = await effectiveRefunds(purchase);
  if (prior.some((refund) => jsonInt(refund, "presentment_amount_cents") <= 0)) return null;
  const remaining =
    rubyToI(presentment.presentment_total_cents) -
    prior.reduce((sum, refund) => sum + jsonInt(refund, "presentment_amount_cents"), 0);
  if (amountCents > remaining) return null;

  let canonical: number;
  if (amountCents === remaining) {
    canonical = await grossAmountRefundableCents(purchase);
  } else {
    // against the remaining balances, so repeated partial refunds cannot exhaust the canonical amount through rounding
    const share = allocateByLargestRemainder(
      await grossAmountRefundableCents(purchase),
      [amountCents, remaining - amountCents],
      remaining,
    )[0]!;
    canonical = Math.min(share, await grossAmountRefundableCents(purchase));
  }
  if (canonical <= 0) return null;

  const snapshot = await resultForPresentmentAmount(purchase, presentment, amountCents);
  return snapshot === null ? null : { canonical_gross_refund_cents: canonical, presentment_refund: snapshot };
}

// PresentmentRefund#result
export async function presentmentRefundResult(
  purchase: PurchaseRecord,
  canonicalGrossRefundCents: number,
): Promise<PresentmentSnapshot | null> {
  const presentment = await presentmentOf(purchase);
  const canonical = rubyToI(canonicalGrossRefundCents);
  if (presentment === null || canonical <= 0) return null;
  if (await anyPriorWithoutSnapshot(purchase)) return null;

  const components = await remainingComponentCents(purchase, presentment);
  if (components.some((cents) => cents < 0)) throw notPorted(OVERDRAWN_COMPONENT);

  if (canonical >= (await grossAmountRefundableCents(purchase))) {
    const amount = await remainingPresentmentAmountCents(purchase, presentment);
    return amount <= 0 ? null : buildResult(presentment, amount, components);
  }
  if ((await remainingPresentmentAmountCents(purchase, presentment)) <= 0) return null;
  // partial_presentment_amount_cents, then the components against what is left
  const share = allocateByLargestRemainder(
    await remainingPresentmentAmountCents(purchase, presentment),
    [canonical, (await grossAmountRefundableCents(purchase)) - canonical],
    await grossAmountRefundableCents(purchase),
  )[0]!;
  const amount = Math.min(share, await remainingPresentmentAmountCents(purchase, presentment));
  if (amount <= 0) return null;
  return buildResult(
    presentment,
    amount,
    allocateByLargestRemainder(amount, components, await remainingPresentmentAmountCents(purchase, presentment)),
  );
}

// PresentmentRefund#tax_only_result
export async function presentmentTaxOnlyResult(
  purchase: PurchaseRecord,
  canonicalGrossRefundCents: number,
): Promise<PresentmentSnapshot | null> {
  const presentment = await presentmentOf(purchase);
  if (presentment === null || rubyToI(canonicalGrossRefundCents) <= 0) return null;
  if (await anyPriorWithoutSnapshot(purchase)) return null;

  const remainingTax =
    rubyToI(presentment.presentment_gumroad_tax_cents) -
    (await refundedPresentmentCents(purchase, "presentment_gumroad_tax_cents"));
  if (remainingTax <= 0 || remainingTax > (await remainingPresentmentAmountCents(purchase, presentment))) return null;
  return buildResult(presentment, remainingTax, [0, 0, 0, remainingTax, 0]);
}

type Notifier = (message: string, context: Record<string, unknown>) => void;

// Purchase#derive_presentment_refund_from_flow_of_funds: nil, an error on the purchase and a report when no derivation is consistent
export async function derivePresentmentRefundFromFlowOfFunds(
  purchase: PurchaseRecord,
  flowOfFunds: SellerFlowOfFunds | null,
  notify: Notifier = (message, context) => notifyError(message, context),
): Promise<DerivedRefund | null> {
  const issued = flowOfFunds?.issuedAmount ?? null;
  const presentment = await presentmentOf(purchase);
  if (presentment === null) throw new TypeError("undefined method 'presentment_currency' for nil");
  const derived =
    issued !== null && issued.currency.toLowerCase() === presentment.presentment_currency.toLowerCase()
      ? await fromPresentmentAmount(purchase, Math.abs(issued.cents))
      : null;
  if (derived !== null) return derived;

  purchase.errors.add("base", BUYER_PRESENTMENT_REFUND_ERROR_MESSAGE);
  const charge = await chargeOfPurchase({ id: purchase.get("id") } as Purchase);
  notify("Buyer-presentment refund blocked: cannot derive canonical amount from flow of funds", {
    purchase_id: purchase.get("id"),
    purchase_external_id: externalId(purchase.get("id")),
    charge_id: charge?.id ?? null,
    purchase_presentment_id: presentment.id,
    flow_of_funds_issued_currency: issued?.currency ?? null,
    flow_of_funds_issued_cents: issued?.cents ?? null,
  });
  return null;
}
