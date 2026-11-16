// Api::Internal::Admin::PayoutsController#issue and ScheduledPayoutsController#create, #execute, #cancel. Each one creates, executes
// or cancels a payout (Stripe, PayPal, balance state), so Node answers the lookups and refusals in front of the work and hands every
// request that clears them back before a write.
import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";

import { failure, halted, isBlank, jsonRendered, paramToS, recordAdminWrite, type AdminRequest } from "./base.ts";
import { handBack } from "./hand-back.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForWrite } from "./user-writes.ts";

const PAYOUTS_SOURCE = "app/controllers/api/internal/admin/payouts_controller.rb";
const SCHEDULED_SOURCE = "app/controllers/api/internal/admin/scheduled_payouts_controller.rb";
// PayoutProcessorType.all
const PAYOUT_PROCESSORS = ["PAYPAL", "STRIPE"];
const CHANGEABLE_STATUSES = ["pending", "flagged"];
const WRAPPER = { key: "scheduled_payout", model: "ScheduledPayout" };

const knownProcessor = (value: unknown, source: string) =>
  PAYOUT_PROCESSORS.includes(paramToS(value, source).toUpperCase());

// fetch_scheduled_payout, then record_admin_write on it: the state refusals are audited, the change itself is Rails'.
async function scheduledPayoutChange(admin: AdminRequest, action: string, refusal: (status: string) => string) {
  const id = decrypt(paramToS(admin.params.id, SCHEDULED_SOURCE));
  const payout = id === null ? null : await db.scheduledPayout.findUnique({ where: { id: BigInt(id) } });
  if (payout === null) return halted(failure("Scheduled payout not found", 404));
  return recordAdminWrite(
    admin,
    { action, target: { type: "ScheduledPayout", id: payout.id, externalId: encrypt(payout.id) }, wrapper: WRAPPER },
    () =>
      CHANGEABLE_STATUSES.includes(payout.status)
        ? handBack("a scheduled payout change", SCHEDULED_SOURCE)
        : Promise.resolve(jsonRendered({ success: false, message: refusal(payout.status) }, 422)),
  );
}

defineAdminRoute(
  {
    method: "POST",
    pattern: "/internal/admin/payouts/issue",
    run: async (admin) => {
      const found = await findUserForWrite(admin, false);
      // fetch_user_for_write is a before_action: a refusal halts the chain.
      if ("refusal" in found) return halted(found.refusal);
      if (!knownProcessor(admin.params.payout_processor, PAYOUTS_SOURCE))
        return failure("payout_processor must be stripe or paypal", 400);
      if (isBlank(admin.params.payout_period_end_date)) return failure("payout_period_end_date is required", 400);
      return handBack("a payout", PAYOUTS_SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/scheduled_payouts",
    run: (admin) => {
      if (isBlank(admin.params.processor)) return Promise.resolve(failure("processor is required", 400));
      if (!knownProcessor(admin.params.processor, SCHEDULED_SOURCE))
        return Promise.resolve(failure("processor must be stripe or paypal", 400));
      return handBack("a scheduled payout", SCHEDULED_SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/scheduled_payouts/:id/execute",
    run: (admin) =>
      scheduledPayoutChange(
        admin,
        "scheduled_payouts.execute",
        (status) => `Cannot execute a ${status} scheduled payout.`,
      ),
  },
  {
    method: "POST",
    pattern: "/internal/admin/scheduled_payouts/:id/cancel",
    run: (admin) =>
      scheduledPayoutChange(
        admin,
        "scheduled_payouts.cancel",
        (status) => `Cannot cancel a ${status} scheduled payout`,
      ),
  },
);
