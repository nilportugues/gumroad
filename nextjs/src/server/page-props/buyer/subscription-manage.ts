// SubscriptionsController#check_can_manage: who may open /subscriptions/:id/manage. The page itself
// (CheckoutPresenter#subscription_manager_props) is not ported, so a visitor who may manage is handed to Rails.
import { timingSafeEqual } from "node:crypto";

import { Prisma, type Subscription } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { trueOriginalPurchaseOf } from "./subscriptions.ts";

export type ManageDecision =
  | { kind: "not_found" }
  | { kind: "allow" }
  // `redirect_to new_subscription_magic_link_path(params[:id], invalid: true)` or without `invalid`.
  | { kind: "magic_link"; invalid: boolean };

export type ManageFacts = {
  subscription: Pick<Subscription, "ended_at" | "token" | "token_expires_at">;
  isInstallmentPlan: boolean;
  chargesCompleted: boolean;
  // `cookies.encrypted[subscription.cookie_key]` and the subscription's external id.
  cookieValue: string | null;
  externalId: string;
  // user_signed_in? && logged_in_user.is_team_member? / == subscription.user / == gifter_user
  signedInMayManage: boolean;
  tokenParam: string | null;
  now: Date;
};

// ActiveSupport::SecurityUtils.secure_compare
export function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

export function decideManageAccess(facts: ManageFacts): ManageDecision {
  const { subscription } = facts;
  if (subscription.ended_at !== null) return { kind: "not_found" };
  if (facts.isInstallmentPlan && facts.chargesCompleted) return { kind: "not_found" };
  if (present(facts.cookieValue) && secureCompare(facts.cookieValue, facts.externalId)) return { kind: "allow" };
  if (facts.signedInMayManage) return { kind: "allow" };
  if (present(facts.tokenParam)) {
    if (present(subscription.token) && secureCompare(facts.tokenParam, subscription.token)) {
      // `@subscription.token_expires_at > Time.current` raises on nil.
      if (subscription.token_expires_at === null) throw new TypeError("undefined method '>' for nil");
      if (subscription.token_expires_at.getTime() > facts.now.getTime()) return { kind: "allow" };
    }
    return { kind: "magic_link", invalid: true };
  }
  return { kind: "magic_link", invalid: false };
}

// The subscription's own facts, read the way the controller does.
export async function loadManageFacts(subscription: Subscription, viewer: { userId: bigint | null; isTeamMember: boolean }) {
  const isInstallmentPlan = SubscriptionFlags.isSet(subscription.flags, "is_installment_plan");
  let chargesCompleted = false;
  if (isInstallmentPlan && subscription.charge_occurrence_count !== null) {
    // charges_completed?: has_fixed_length? && successful_purchases.count == charge_occurrence_count
    const state = SubscriptionFlags.isSet(subscription.flags, "is_test_subscription") ? "test_successful" : "successful";
    const [row] = await selectRows<{ count: bigint }>(
      Prisma.sql`SELECT COUNT(*) AS count FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscription.id} AND ${column("purchases", "purchase_state")} = ${state}`,
    );
    chargesCompleted = Number(row!.count) === subscription.charge_occurrence_count;
  }
  const signedInMayManage = viewer.userId !== null && (viewer.isTeamMember || viewer.userId === subscription.user_id || (await isGifter(subscription, viewer.userId)));
  return { isInstallmentPlan, chargesCompleted, signedInMayManage, externalId: encrypt(subscription.id) };
}

// `gifter_user.present? && logged_in_user == gifter_user`: the buyer of the gift the subscription was sold as.
async function isGifter(subscription: Subscription, userId: bigint): Promise<boolean> {
  const original = await trueOriginalPurchaseOf(subscription.id);
  if (!original || !PurchaseFlags.isSet(original.flags, "is_gift_sender_purchase")) return false;
  const gift = await db.gift.findFirst({ where: { gifter_purchase_id: original.id } });
  if (!gift || gift.gifter_purchase_id === null) return false;
  const gifterPurchase = await db.purchase.findUnique({ where: { id: gift.gifter_purchase_id }, select: { purchaser_id: true } });
  return gifterPurchase?.purchaser_id != null && BigInt(gifterPurchase.purchaser_id) === userId;
}
