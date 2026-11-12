// Port of app/sidekiq/activate_integrations_worker.rb. `Purchase.find` and the lookup of the purchase's enabled Circle integration
// (`Purchase#find_enabled_integration`) run in Node and finish a purchase with none; one with an integration is the `CircleApi#add_member`
// call, whose request and rate-limit write are the ones Rails made. Circle's answer is never read, so no status changes the job.
// Handed back before any call: an id Rails casts, an api key or details Ruby would render differently, a request that gets no answer.
// Golden: __fixtures__/activate-integrations-worker.golden.json (scripts/golden/activate-integrations-worker.rb).
import type { Purchase } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { CIRCLE_INTEGRATION } from "../../server/models/purchase-integrations.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { activateIntegration, runVendorCalls } from "./support/integration-services.ts";
import { modelJob } from "./support/job-deps.ts";

export const activateIntegrationsWorkerWith = modelJob({ min: 1 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  const purchase = new PurchaseRecord(await findByIdBang<Purchase>("Purchase", id), null);
  const calls = await beforeSideEffects(() => activateIntegration(purchase, CIRCLE_INTEGRATION));
  await runVendorCalls(calls);
});
export const activateIntegrationsWorker = activateIntegrationsWorkerWith();
