// Port of the guards of app/sidekiq/refresh_merchant_account_payment_method_availability_worker.rb: an account that was deleted, whose
// charge processor is not alive, or that is not a Stripe Connect account is left alone. One that is goes to
// StripeConnectPaymentMethodAvailabilityService#refresh! (a Stripe read and the snapshot write), which stays with Rails: the job is
// handed back right after the read, and so is a json_data Ruby cannot dig into.
// Golden: __fixtures__/refresh-merchant-account-payment-method-availability-worker.golden.json
// (scripts/golden/refresh-merchant-account-payment-method-availability-worker.rb); the service was replaced by a recorder there.
import type { MerchantAccount } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { isStripeConnectAccount } from "../../server/models/merchant-account.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";

import { modelJob } from "./support/job-deps.ts";

export const refreshMerchantAccountPaymentMethodAvailabilityWorkerWith = modelJob(
  { min: 1 },
  async ([merchantAccountId]) => {
    const id = await beforeSideEffects(() => recordIdFrom(merchantAccountId, "MerchantAccount.find"));
    const account = await findOneBy<MerchantAccount>("MerchantAccount", "id", id);
    if (account === null) throw new RecordNotFound(`Couldn't find MerchantAccount with 'id'=${String(id)}`);

    // MerchantAccount#alive? and #charge_processor_alive?
    if (account.deleted_at !== null) return;
    if (account.charge_processor_alive_at === null || account.charge_processor_deleted_at !== null) return;

    let connect: boolean;
    try {
      connect = isStripeConnectAccount(account);
    } catch (error) {
      throw new HandBackToRuby(`json_data of the account cannot be read: ${(error as Error).message}`);
    }
    if (!connect) return;

    throw new HandBackToRuby("StripeConnectPaymentMethodAvailabilityService is not ported");
  },
);

export const refreshMerchantAccountPaymentMethodAvailabilityWorker =
  refreshMerchantAccountPaymentMethodAvailabilityWorkerWith();
