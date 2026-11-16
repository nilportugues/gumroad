// Api::V2::RefundPoliciesController: the seller's account-level refund policy.
import type { User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { RefundPolicies } from "../../models/refund-policy.ts";
import { isBlank } from "../../models/runtime/validators.ts";
import { UserFlags } from "../../models/user.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";

import {
  type ApiV2Input,
  EDIT_PRODUCTS_SCOPES,
  PUBLIC_READ_SCOPES,
  registerApiV2,
  renderResponse,
  successWithObject,
  toSentence,
} from "./base.ts";

// RefundPolicy::ALLOWED_REFUND_PERIODS_IN_DAYS
export const REFUND_POLICY_TITLES: Record<number, string> = {
  0: "No refunds allowed",
  7: "7-day money back guarantee",
  14: "14-day money back guarantee",
  30: "30-day money back guarantee",
  183: "6-month money back guarantee",
};
// User::LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY, Time.new(2025, 3, 31).end_of_day (UTC)
const LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY = Date.UTC(2025, 2, 31, 23, 59, 59, 999);

// User#account_level_refund_policy_enabled?
export async function accountLevelRefundPolicyEnabled(seller: User, now = new Date()): Promise<boolean> {
  if (await isFeatureEnabled("seller_refund_policy_disabled_for_all")) return false;
  const delayed = (await isFeatureEnabled("account_level_refund_policy_delayed_for_sellers", userActor(seller.id))) && now.getTime() <= LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY;
  if (delayed) return false;
  return UserFlags.isSet(seller.flags, "refund_policy_enabled");
}

// `user.refund_policy`: the seller's policy that belongs to no product.
export const sellerRefundPolicy = (seller: User) => db.refundPolicy.findFirst({ where: { seller_id: seller.id, product_id: null }, orderBy: { id: "asc" } });

export async function serializedRefundPolicy(seller: User) {
  const policy = await sellerRefundPolicy(seller);
  if (!policy) throw new TypeError("undefined method 'max_refund_period_in_days' for nil");
  const days = policy.max_refund_period_in_days;
  return {
    refund_period: days === 0 ? "none" : String(days),
    title: days === null ? null : (REFUND_POLICY_TITLES[days] ?? null),
    fine_print: policy.fine_print,
    in_effect: await accountLevelRefundPolicyEnabled(seller),
  };
}

registerApiV2({ method: "GET", pattern: "/v2/refund_policy", scopes: PUBLIC_READ_SCOPES, run: async (input) => successWithObject("refund_policy", await serializedRefundPolicy(input.owner)) });

// Api::V2::RefundPoliciesController::REFUND_PERIOD_VALUES
const REFUND_PERIOD_VALUES: Record<string, number> = { none: 0, "7": 7, "14": 14, "30": 30, "183": 183 };
const REFUND_PERIOD_ALLOWED_VALUES = ["none", "7", "14", "30", "183"];
const NOT_IN_EFFECT_MESSAGE = "The account-level refund policy is not in effect for this seller.";

// A parameter Rails would cast (a number, a list, a hash) is the one thing the port does not follow.
function stringOrNull(value: unknown, what: string): string | null {
  if (value === undefined || value === null || typeof value === "string") return value ?? null;
  throw new NotPortedError(`a ${what} that is not a string`);
}

export async function updateRefundPolicy({ owner, params }: ApiV2Input) {
  if (!(await accountLevelRefundPolicyEnabled(owner))) return renderResponse(false, { message: NOT_IN_EFFECT_MESSAGE });
  const period = stringOrNull(params.refund_period, "refund period");
  if (period === null || isBlank(period)) return renderResponse(false, { message: "Refund period is required." });
  const finePrint = "fine_print" in params ? stringOrNull(params.fine_print, "fine print") : undefined;

  const row = await sellerRefundPolicy(owner);
  if (!row) throw new TypeError("undefined method 'update' for nil");
  const policy = RefundPolicies.load(row);
  const saved = await RefundPolicies.update(policy, {
    max_refund_period_in_days: Object.hasOwn(REFUND_PERIOD_VALUES, period) ? REFUND_PERIOD_VALUES[period]! : null,
    ...(finePrint === undefined ? {} : { fine_print: finePrint }),
  });
  if (saved) return successWithObject("refund_policy", await serializedRefundPolicy(owner));

  const message = policy.errors.added("max_refund_period_in_days", "inclusion")
    ? `Refund period must be one of: ${REFUND_PERIOD_ALLOWED_VALUES.join(", ")}.`
    : toSentence(policy.errors.fullMessages());
  return renderResponse(false, { message });
}

registerApiV2(
  { method: "PUT", pattern: "/v2/refund_policy", scopes: EDIT_PRODUCTS_SCOPES, run: updateRefundPolicy },
  { method: "PATCH", pattern: "/v2/refund_policy", scopes: EDIT_PRODUCTS_SCOPES, run: updateRefundPolicy },
);
