// Port of app/sidekiq/reconcile_client_confirmed_charge_job.rb up to `recover_missing_payment_intent!`. The three guards that open the job
// (no charge, not client confirmed, no in-progress purchase) run in Node and end it. A charge that passes them searches Stripe and then
// syncs, fails or updates purchases, so it goes back to Rails whole before any of that. An id Rails casts goes back before any read.
// Golden: __fixtures__/reconcile-client-confirmed-charge-job.golden.json (scripts/golden/reconcile-client-confirmed-charge-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const CLIENT_CONFIRMED = 2n;
const IN_PROGRESS = "in_progress";

export const reconcileClientConfirmedChargeJobWith = modelJob({ min: 1, max: 2 }, async ([chargeId]) => {
  // `Charge.find_by(id: nil)` is a statement of its own (`id IS NULL`).
  const id = chargeId === null ? null : await beforeSideEffects(() => recordIdFrom(chargeId, "Charge.find_by"));
  const charge = await findOneBy<{ id: bigint; flags: bigint }>("Charge", "id", id, true);
  if (charge === null) return;
  if ((BigInt(charge.flags) & CLIENT_CONFIRMED) === 0n) return;

  // `charge.purchases.none?(&:in_progress?)` loads the has_many through.
  const purchases = await selectRows<{ purchase_state: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName("purchases")}.*`)} FROM ${table("purchases")} INNER JOIN ${table("charge_purchases")} ON ${column("purchases", "id")} = ${column("charge_purchases", "purchase_id")} WHERE ${column("charge_purchases", "charge_id")} = ${charge.id}`,
  );
  if (!purchases.some((purchase) => purchase.purchase_state === IN_PROGRESS)) return;

  throw new HandBackToRuby("the missing PaymentIntent is searched on Stripe and the purchases are synced");
});
export const reconcileClientConfirmedChargeJob = reconcileClientConfirmedChargeJobWith();
