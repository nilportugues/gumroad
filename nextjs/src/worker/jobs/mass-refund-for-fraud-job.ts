// Port of app/sidekiq/mass_refund_for_fraud_job.rb up to the first refund. `Purchase.find_by_external_id` and the product check run in
// Node: an external id that is no purchase of the product only counts as failed in a hash the job logs (it writes nothing). The first
// purchase of the product means `refund_for_fraud_and_block_buyer!` (a processor refund), which hands back to Rails before anything is
// written, as does an argument Ruby would treat differently (a product id that is not an Integer, external ids that are not a list of
// strings). Golden: __fixtures__/mass-refund-for-fraud-job.golden.json (scripts/golden/mass-refund-for-fraud-job.rb).
import type { Purchase } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { findOneBy } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const massRefundForFraudJobWith = modelJob({ min: 3 }, async ([productId, externalIds]) => {
  if (typeof productId !== "number" || !Number.isSafeInteger(productId))
    throw new HandBackToRuby("the product id is not an Integer");
  if (!Array.isArray(externalIds) || !externalIds.every((externalId) => typeof externalId === "string")) {
    throw new HandBackToRuby("the external ids are not a list of strings");
  }

  for (const externalId of externalIds) {
    // from_external_id: nil for an id that does not decrypt, which find_by(id: nil) reads as `id IS NULL`
    const purchase = await findOneBy<Purchase>("Purchase", "id", decrypt(externalId), true);
    if (purchase !== null && purchase.link_id === BigInt(productId)) {
      throw new HandBackToRuby("a purchase of the product is refunded for fraud");
    }
  }
});
export const massRefundForFraudJob = massRefundForFraudJobWith();
