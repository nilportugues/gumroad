// Read side of app/models/subscription.rb: the flags and the scopes the deactivation sweep uses.
// Nothing here writes a subscriptions row.
import { Prisma } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";

export const SUBSCRIPTIONS = "subscriptions";

export const SubscriptionFlags = defineFlags(
  SUBSCRIPTIONS,
  {
    1: "is_test_subscription",
    2: "cancelled_by_buyer",
    3: "cancelled_by_admin",
    4: "DEPRECATED_flat_fee_applicable",
    5: "is_resubscription_pending_confirmation",
    6: "mor_fee_applicable",
    7: "is_installment_plan",
    8: "renewal_disabled_due_to_indian_card_mandate",
    9: "indian_card_mandate_requires_reauthorization",
    10: "vat_exempt_territory",
    11: "indian_card_mandate_hold_pending",
  },
  { queryMode: "bit_operator" },
);

// A string `where` clause is wrapped in parentheses by ActiveRecord.
const wrapped = (sql: Prisma.Sql) => Prisma.sql`(${sql})`;

// `not_is_test_subscription` (flag_shih_tzu's scope).
export const notIsTestSubscription = () => wrapped(SubscriptionFlags.condition("is_test_subscription", false));

export const DEACTIVATION_COLUMNS = ["cancelled_at", "failed_at", "ended_at"] as const;

// `Subscription.where("<column> < ? and deactivated_at is null", now).not_is_test_subscription`, the
// relations of FindExpiredSubscriptionsToSetAsDeactivatedWorker. `now` is quoted with its fraction:
// a raw clause is not cast to the column's precision.
export function pastAndNotDeactivated(columnName: (typeof DEACTIVATION_COLUMNS)[number], now: Date): Prisma.Sql {
  return Prisma.sql`${wrapped(Prisma.sql`${Prisma.raw(columnName)} < ${now} and deactivated_at is null`)} AND ${notIsTestSubscription()}`;
}
