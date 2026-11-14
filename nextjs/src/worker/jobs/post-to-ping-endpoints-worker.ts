// Port of app/sidekiq/post_to_ping_endpoints_worker.rb up to the ping payload. A subscription (or, without one, a purchase) is found in Node
// on the writing role, and the two states that end a subscription ping early (a `subscription_ended` ping for one that is still active, a
// `subscription_restarted` ping for one with a termination date) finish the job. Everything after builds the payload, reads the seller's
// ping targets, notifies and enqueues PostToIndividualPingEndpointWorker, so a record that is found goes back to Rails before that.
// A subscription id or purchase id Rails casts goes back before any read.
// Golden: __fixtures__/post-to-ping-endpoints-worker.golden.json (scripts/golden/post-to-ping-endpoints-worker.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";

import { modelJob } from "./support/job-deps.ts";

const SUBSCRIPTION_ENDED_RESOURCE_NAME = "subscription_ended";
const SUBSCRIPTION_RESTARTED_RESOURCE_NAME = "subscription_restarted";

type Subscription = {
  deactivated_at: Date | null;
  ended_at: Date | null;
  cancelled_at: Date | null;
  failed_at: Date | null;
};

// `subscription_id.present?` for the values Node reproduces: nil, false and "" are blank, an Integer or the digits of one is a
// subscription. Anything else (a float, a word, whitespace) goes back before any read.
const subscriptionIdFrom = (value: unknown): bigint | null =>
  value === undefined || value === null || value === false || value === ""
    ? null
    : recordIdFrom(value, "Subscription.find");

export const postToPingEndpointsWorkerWith = modelJob(
  { min: 2, max: 5 },
  async ([purchaseId, , resourceName, subscriptionArg]) => {
    const subscriptionId = await beforeSideEffects(() => subscriptionIdFrom(subscriptionArg));
    // `Purchase.find(nil)` raises before any statement.
    if (subscriptionId === null && purchaseId === null)
      throw new RecordNotFound("Couldn't find Purchase without an ID");
    const purchaseKey =
      subscriptionId === null ? await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find")) : null;

    // ApplicationRecord.connected_to(role: :writing)
    await connectedTo("writing", async () => {
      if (subscriptionId !== null) {
        const subscription = await findByIdBang<Subscription & Record<string, unknown>>("Subscription", subscriptionId);
        if (resourceName === SUBSCRIPTION_ENDED_RESOURCE_NAME && subscription.deactivated_at === null) return;
        // `termination_date.present?`: ended_at || cancelled_at || failed_at || deactivated_at
        const terminated =
          subscription.ended_at !== null ||
          subscription.cancelled_at !== null ||
          subscription.failed_at !== null ||
          subscription.deactivated_at !== null;
        if (resourceName === SUBSCRIPTION_RESTARTED_RESOURCE_NAME && terminated) return;
        throw new HandBackToRuby("the subscription's ping payload is built and its deliveries are enqueued");
      }

      await findByIdBang("Purchase", purchaseKey as bigint);
      throw new HandBackToRuby("the purchase's ping payload is built and its deliveries are enqueued");
    });
  },
);
export const postToPingEndpointsWorker = postToPingEndpointsWorkerWith();
