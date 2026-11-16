// Port of app/sidekiq/activate_integrations_worker.rb up to the Circle API call. `Purchase.find` and the lookup of the purchase's
// enabled Circle integration (`Purchase#find_enabled_integration`) run in Node and finish a purchase with none; one with an integration
// means `CircleApi#add_member`, which hands back to Rails before anything is written, as does an id Rails casts.
// Golden: __fixtures__/activate-integrations-worker.golden.json (scripts/golden/activate-integrations-worker.rb).
import type { Purchase } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { CIRCLE_INTEGRATION, findEnabledIntegration } from "../../server/models/purchase-integrations.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const activateIntegrationsWorkerWith = modelJob({ min: 1 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  const purchase = new PurchaseRecord(await findByIdBang<Purchase>("Purchase", id), null);
  const integration = await beforeSideEffects(() => findEnabledIntegration(purchase, CIRCLE_INTEGRATION));
  if (integration === null) return;

  throw new HandBackToRuby("a Circle integration to add the buyer to");
});
export const activateIntegrationsWorker = activateIntegrationsWorkerWith();
