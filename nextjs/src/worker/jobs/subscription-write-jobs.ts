// Ports of the jobs that deactivate a subscription:
//   app/sidekiq/end_subscription_worker.rb
//   app/sidekiq/unsubscribe_and_fail_worker.rb
//   app/sidekiq/set_subscription_as_deactivated_worker.rb
// The writes are the Subscription model's (server/models/subscription-writes.ts). Reads that precede the
// first write run inside beforeSideEffects: what Node cannot do (a failed charge on a mandate card, which
// Rails recovers through Stripe; a member cancellation workflow filter it cannot judge; offer-code pricing) hands the job back
// to Rails untouched.
// Golden: __fixtures__/subscription-writes-jobs.golden.json (scripts/golden/subscription-writes-jobs.rb).
import type { Subscription } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { checkMandateRecovery, deactivateBang, endSubscriptionBang, isCancelled, loadSubscription, readWorkflowsForCancellation, subscriptionView, unsubscribeAndFailBang, type SubscriptionModel } from "../../server/models/subscription-writes.ts";
import { defaultSubscriptionDeps, type SubscriptionDeps } from "../../server/models/subscription.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

export type SubscriptionWriteJobDeps = Pick<SubscriptionDeps, "featureActive">;

async function findSubscription(argument: JsonValue, deps: JobDeps, extras: Partial<SubscriptionWriteJobDeps>): Promise<SubscriptionModel> {
  const row = await findByIdBang<Subscription>("Subscription", recordIdFrom(argument, "Subscription.find"));
  return loadSubscription(row, { now: deps.now, featureActive: extras.featureActive ?? defaultSubscriptionDeps.featureActive });
}

// EndSubscriptionWorker
export const endSubscriptionWorkerWith = (overrides: Partial<JobDeps> = {}, extras: Partial<SubscriptionWriteJobDeps> = {}) =>
  modelJob({ min: 1 }, async (args, deps) => {
    const subscription = await beforeSideEffects(async () => {
      const record = await findSubscription(args[0]!, deps, extras);
      const view = subscriptionView(record);
      if (view.isTestSubscription || !view.alive(false) || !(await view.chargesCompleted())) return null;
      return record;
    });
    if (subscription !== null) await endSubscriptionBang(subscription);
  })(overrides);

// UnsubscribeAndFailWorker. The `:mandate_recovered` result belongs to the Stripe recovery, which is
// handed back, so the follow-up RecurringChargeWorker push never happens here.
export const unsubscribeAndFailWorkerWith = (overrides: Partial<JobDeps> = {}, extras: Partial<SubscriptionWriteJobDeps> = {}) =>
  modelJob({ min: 1 }, async (args, deps) => {
    const subscription = await beforeSideEffects(async () => {
      const record = await findSubscription(args[0]!, deps, extras);
      const view = subscriptionView(record);
      if (!view.alive(false) || view.isTestSubscription || !(await view.overdueForCharge())) return null;
      await checkMandateRecovery(record);
      return record;
    });
    if (subscription !== null) await unsubscribeAndFailBang(subscription);
  })(overrides);

// SetSubscriptionAsDeactivatedWorker
export const setSubscriptionAsDeactivatedWorkerWith = (overrides: Partial<JobDeps> = {}, extras: Partial<SubscriptionWriteJobDeps> = {}) =>
  modelJob({ min: 1 }, async (args, deps) => {
    const plan = await beforeSideEffects(async () => {
      const record = await findSubscription(args[0]!, deps, extras);
      if (subscriptionView(record).alive()) return null;
      return { record, workflows: isCancelled(record) ? await readWorkflowsForCancellation(record) : undefined };
    });
    if (plan !== null) await deactivateBang(plan.record, { workflows: plan.workflows });
  })(overrides);

export const endSubscriptionWorker = endSubscriptionWorkerWith();
export const unsubscribeAndFailWorker = unsubscribeAndFailWorkerWith();
export const setSubscriptionAsDeactivatedWorker = setSubscriptionAsDeactivatedWorkerWith();
