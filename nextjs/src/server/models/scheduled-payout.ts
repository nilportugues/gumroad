// Port of app/models/scheduled_payout.rb for `user.scheduled_payouts.create!`. execute! and the
// scopes the payout jobs use are not ported. Golden: worker/jobs/__fixtures__/suspend-jobs.golden.json.
import { Prisma, type ScheduledPayout } from "@prisma/client";

import { advance } from "./concerns/ruby-time.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesInclusionOf, validatesNumericalityOf, validatesPresenceOf } from "./runtime/validators.ts";
import { column, columnIn, selectRows, table } from "./sql.ts";

export const SCHEDULED_PAYOUT_ACTIONS = ["refund", "payout", "hold"] as const;
const STATUSES = ["pending", "executed", "cancelled", "flagged", "held"];
const IN_PROGRESS_STATUSES = ["pending", "flagged", "held"];
// PayoutProcessorType.all
const PAYOUT_PROCESSOR_TYPES = ["PAYPAL", "STRIPE"];

export const ScheduledPayouts = defineModel<ScheduledPayout>({
  rubyClass: "ScheduledPayout",
  prismaModel: "ScheduledPayout",
  delegate: (tx) => tx.scheduledPayout as never,
  beforeValidation: [
    {
      name: "set_scheduled_at",
      on: ["create"],
      run(record, ctx) {
        const delayDays = record.get("delay_days");
        if (record.get("scheduled_at") == null && delayDays != null) record.set("scheduled_at", advance((ctx.now ?? (() => new Date()))(), { days: Number(delayDays) }));
      },
    },
  ],
  validations: [
    validatesPresenceOf<ScheduledPayout>(["action"]),
    validatesInclusionOf<ScheduledPayout>(["action"], { in: SCHEDULED_PAYOUT_ACTIONS }),
    validatesPresenceOf<ScheduledPayout>(["status"]),
    validatesInclusionOf<ScheduledPayout>(["status"], { in: STATUSES }),
    validatesInclusionOf<ScheduledPayout>(["processor"], { in: PAYOUT_PROCESSOR_TYPES, if: (record) => record.get("processor") != null }),
    validatesPresenceOf<ScheduledPayout>(["delay_days"]),
    validatesNumericalityOf<ScheduledPayout>(["delay_days"], { only_integer: true, greater_than_or_equal_to: 0 }),
    validatesPresenceOf<ScheduledPayout>(["scheduled_at"]),
    validatesPresenceOf<ScheduledPayout>(["payout_amount_cents"]),
    validatesNumericalityOf<ScheduledPayout>(["payout_amount_cents"], { only_integer: true, greater_than_or_equal_to: 0 }),
    {
      name: "no_in_progress_scheduled_payout_for_user",
      on: ["create"],
      async run(record) {
        const userId = record.get("user_id");
        if (userId == null) return;
        const t = "scheduled_payouts";
        const [exists] = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table(t)} WHERE ${column(t, "user_id")} = ${userId} AND ${columnIn(t, "status", IN_PROGRESS_STATUSES)} LIMIT 1`,
        );
        if (exists) record.errors.add("base", "User already has a scheduled payout in progress");
      },
    },
  ],
});
