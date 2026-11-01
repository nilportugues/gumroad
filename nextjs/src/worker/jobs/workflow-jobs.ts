// Ports of the workflow and installment jobs that only read, enqueue, or make one small write:
//   app/sidekiq/schedule_workflow_emails_worker.rb
//   app/sidekiq/update_installment_events_count_cache_worker.rb
//   app/sidekiq/flush_installment_delivered_deltas_job.rb
//   app/sidekiq/send_workflow_installment_reschedule_job.rb (its guard; the send itself is Ruby's)
//   app/sidekiq/schedule_affiliate_workflow_jobs_job.rb (the sweep, and a token with no assignments)
// `SendWorkflowInstallmentWorker`, which these enqueue, still runs in Rails.
// Golden: __fixtures__/workflow-jobs.golden.json (scripts/golden/workflow-jobs.rb).
import { Prisma, type Installment, type ProductAffiliate } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { rubyToI } from "../../server/models/concerns/ruby-numeric.ts";
import { preloadAffiliates, scheduleWorkflowJobs, sendsPosts, withProducts } from "../../server/models/direct-affiliate.ts";
import { enqueueWorkflowSchedule, assignmentRowsOfToken, clearWorkflowSchedule, pendingWorkflowScheduleTokens, WorkflowJobNotEnqueuedError, workflowScheduleDispatchable } from "../../server/models/product-affiliate.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { findPurchaseBang, purchaseIdFrom } from "../../server/models/purchase.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, execute, selectRows, table } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";
import { schedulableInstallments, SEND_WORKFLOW_INSTALLMENT_WORKER, type WorkflowPush } from "../../server/models/workflow-scheduling.ts";
import { aliveWorkflowsOfLink, aliveWorkflowsOfSeller, RECIPIENT_TYPES } from "../../server/models/workflow.ts";
import { checkArity } from "./arity.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

// `Purchase#all_workflows`: the product's workflows, then the seller's seller and audience ones. The
// seller loads before the product's relation does, because `+` evaluates its right side first.
export async function allWorkflows(purchase: PurchaseRecord) {
  const link = await purchase.link();
  if (link === null) throw new TypeError("undefined method 'workflows' for nil");
  const seller = await purchase.seller();
  if (seller === null) throw new TypeError("undefined method 'workflows' for nil");
  return [...(await aliveWorkflowsOfLink(link.id)), ...(await aliveWorkflowsOfSeller(seller.id, RECIPIENT_TYPES.sellerOrAudience))];
}

// ScheduleWorkflowEmailsWorker. `Purchase#schedule_workflows` reads for every workflow before it pushes
// anything for the next one, and pushes touch only Redis, so Node judges everything first and pushes
// after: a hand-back then leaves nothing queued.
export const scheduleWorkflowEmailsWorkerWith = modelJob({ min: 1 }, async (args) => {
  const pushes = await beforeSideEffects(async () => {
    const purchase = new PurchaseRecord(await findPurchaseBang(purchaseIdFrom(args[0])), null);
    const pushes: WorkflowPush[] = [];
    for (const workflow of await allWorkflows(purchase)) {
      if (workflow.abandonedCartType) continue;
      if (!workflow.newCustomerTrigger) continue;
      if (!(await workflow.appliesToPurchase(purchase))) continue;
      pushes.push(...(await schedulableInstallments(workflow, { published: true })).map(({ installment, rule }) => purchasePush(purchase, installment, rule)));
    }
    return pushes;
  });
  for (const push of pushes) await performAsync(SEND_WORKFLOW_INSTALLMENT_WORKER, push.args, { at: push.at });
});

function purchasePush(purchase: PurchaseRecord, installment: Installment, rule: { version: number; delayed_delivery_time: number | null }): WorkflowPush {
  if (rule.delayed_delivery_time === null) throw new NotPortedError("an installment rule without a delay", "installment_rule.rb");
  const createdAt = purchase.row.created_at;
  if (createdAt === null) throw new NotPortedError("a purchase without created_at", "purchase.rb");
  return { at: new Date(createdAt.getTime() + rule.delayed_delivery_time * 1000), args: [installment.id, rule.version, Number(purchase.id), null, null] };
}

// UpdateInstallmentEventsCountCacheWorker
export const updateInstallmentEventsCountCacheWorker = modelJob({ min: 1 }, async (args) => {
  const installment = await findByIdBang<Installment>("Installment", await beforeSideEffects(() => recordIdFrom(args[0], "Installment.find")));
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("installment_events")} WHERE ${column("installment_events", "installment_id")} = ${installment.id}`,
  );
  // `update_column` skips validations and callbacks, and writes whether or not the value changed.
  await execute(Prisma.sql`UPDATE ${table("installments")} SET ${column("installments", "installment_events_count")} = ${Number(row!["COUNT(*)"])} WHERE ${column("installments", "id")} = ${installment.id}`);
})();

// ----- FlushInstallmentDeliveredDeltasJob

const DELIVERED_DELTA_IDS = "installment:delivered_delta_ids";
const deliveredDeltaKey = (installmentId: string) => `installment:${installmentId}:delivered_delta`;
const DELTA_TTL_SECONDS = 2 * 24 * 60 * 60;
// Installment::REMOVE_DELIVERED_DELTA_IF_DRAINED
const REMOVE_DELIVERED_DELTA_IF_DRAINED = `
local delta = redis.call('GET', KEYS[1])
if delta == false or delta == '0' then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

// A failure of the Redis connection, which `flush_delivered_deltas!` swallows; any other error
// (MySQL's) is raised after the delta is put back.
class RedisFailure extends Error {
  cause: unknown;
  constructor(cause: unknown) {
    super("redis failure");
    this.cause = cause;
  }
}

async function viaRedis<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new RedisFailure(error);
  }
}

// `update_counters(installment_id, customer_count: delta)`
async function updateCustomerCount(installmentId: string, delta: number): Promise<void> {
  const id = recordIdFrom(installmentId, "update_counters");
  const customerCount = column("installments", "customer_count");
  const change = Prisma.raw(`${delta < 0 ? "-" : "+"} ${Math.abs(delta)}`);
  await execute(Prisma.sql`UPDATE ${table("installments")} SET ${customerCount} = COALESCE(${customerCount}, 0) ${change} WHERE ${column("installments", "id")} = ${id}`);
}

export type FlushDeps = { redis: () => Redis };

// `Installment.flush_delivered_deltas!`: claim each delta with GETSET 0 before the UPDATE, so a crash
// after it cannot apply the same delta twice; put it back if the UPDATE fails.
export const flushInstallmentDeliveredDeltasJobWith = (overrides: Partial<JobDeps> = {}, flush: Partial<FlushDeps> = {}) => {
  const redis = flush.redis ?? (() => getRedis("main"));
  return modelJob({ min: 0 }, async () => {
    try {
      const ids = await viaRedis(() => redis().smembers(DELIVERED_DELTA_IDS));
      for (const installmentId of ids) {
        const key = deliveredDeltaKey(installmentId);
        const delta = rubyToI(await viaRedis(() => redis().getset(key, "0")));
        if (delta !== 0) {
          try {
            await updateCustomerCount(installmentId, delta);
          } catch (error) {
            await viaRedis(async () => {
              await redis().incrby(key, delta);
              await redis().expire(key, DELTA_TTL_SECONDS);
            });
            throw error;
          }
        }
        await viaRedis(() => redis().eval(REMOVE_DELIVERED_DELTA_IF_DRAINED, 2, key, DELIVERED_DELTA_IDS, installmentId));
      }
    } catch (error) {
      if (!(error instanceof RedisFailure)) throw error;
    }
  })(overrides);
};

// ----- SendWorkflowInstallmentRescheduleJob

// `present?` of a job argument.
function present(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// The job returns unless exactly one recipient is set, and otherwise runs SendWorkflowInstallmentWorker
// (which sends mail and is not ported): that case goes back to Rails.
export const sendWorkflowInstallmentRescheduleJobWith = (overrides: Partial<JobDeps> = {}) => {
  const run = modelJob({ min: 7 }, async (args) => {
    checkArity(args, 7);
    const [, , purchaseId, followerId, affiliateUserId, subscriptionId] = args;
    if ([purchaseId, followerId, affiliateUserId, subscriptionId].filter(present).length !== 1) return;
    await beforeSideEffects(() => {
      throw new NotPortedError("SendWorkflowInstallmentWorker#perform", "send_workflow_installment_worker.rb:11");
    });
  });
  return run(overrides);
};

// ----- ScheduleAffiliateWorkflowJobsJob

// `ApplicationRecord.connected_to(role: :writing)` wraps the whole job. Without a token it re-enqueues the
// tokens whose first push was lost. With one it schedules the workflows of each affiliate's assignments
// (`DirectAffiliate#schedule_workflow_jobs`) and clears the token per affiliate.
//
// An affiliate is judged in full before its first push, so a hand-back leaves nothing queued for it. The affiliates
// before it were completed and cleared; Rails then finds only the assignments that still hold the token.
export const scheduleAffiliateWorkflowJobsJobWith = (overrides: Partial<JobDeps & { logError: (message: string) => void }> = {}) =>
  modelJob({ min: 0, max: 1 }, async (args, deps) => {
    const logError = overrides.logError ?? ((message: string) => console.error(message));
    const token = args[0] ?? null;
    await connectedTo("writing", async () => {
      if (token === null) {
        for (const pending of await pendingWorkflowScheduleTokens()) {
          if (workflowScheduleDispatchable(pending, deps.now())) await enqueueWorkflowSchedule(pending, { ...deps, logError });
        }
        return;
      }
      if (typeof token !== "string") await beforeSideEffects(() => Promise.reject(new NotPortedError("a workflow_schedule_token that is not a String", "schedule_affiliate_workflow_jobs_job.rb")));
      const assignments = await assignmentRowsOfToken(token as string);
      if (assignments.length === 0) return;
      const affiliates = await preloadAffiliates(assignments);
      await withProducts(assignments);
      const groups = new Map<number | null, ProductAffiliate[]>();
      for (const assignment of assignments) groups.set(assignment.affiliate_id, [...(groups.get(assignment.affiliate_id) ?? []), assignment]);
      for (const [affiliateId, group] of groups) {
        const affiliate = affiliateId === null ? null : (affiliates.get(affiliateId) ?? null);
        if (affiliate !== null && affiliate.type === "DirectAffiliate" && affiliate.deleted_at === null && sendsPosts(affiliate)) {
          const pushes = await beforeSideEffects(() => scheduleWorkflowJobs(affiliate, group));
          for (const push of pushes) {
            const jid = await performAsync(SEND_WORKFLOW_INSTALLMENT_WORKER, push.args, { at: push.at });
            if (!jid) throw new WorkflowJobNotEnqueuedError("Sidekiq did not enqueue the affiliate workflow email");
          }
        }
        // Clear per affiliate so a retry after a mid-batch failure does not re-send completed affiliates' emails.
        await clearWorkflowSchedule(group.map((assignment) => assignment.id), token as string);
      }
    });
  })(overrides);

export const scheduleWorkflowEmailsWorker = scheduleWorkflowEmailsWorkerWith();
export const scheduleAffiliateWorkflowJobsJob = scheduleAffiliateWorkflowJobsJobWith();
export const flushInstallmentDeliveredDeltasJob = flushInstallmentDeliveredDeltasJobWith();
export const sendWorkflowInstallmentRescheduleJob = sendWorkflowInstallmentRescheduleJobWith();
