// Port of app/sidekiq/send_workflow_installment_worker.rb: sends one workflow installment to one recipient
// (a purchase, a follower, an affiliate user or a cancelled membership) if the rule it was scheduled under is
// still current, and the post is still sendable.
// Golden: __fixtures__/post-email-sends.golden.json (scripts/golden/post-email-sends.rb).
//
// Handed back to Rails, before the job's first write: a reschedule whose filters or reference time Node does not read (see
// installment-reschedule.ts).
import { Prisma, type InstallmentRule, type User } from "@prisma/client";
import type { Redis } from "ioredis";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { cachedVersionState, cacheVersionBang } from "../../server/models/installment-rule.ts";
import { InstallmentPost } from "../../server/models/installment-post.ts";
import { currentRecipientReferenceTime, recipientMatchesCurrentAudience, rescheduleWithCurrentRule, type RecipientIds } from "../../server/models/installment-reschedule.ts";
import { retiredFor, sendInstallmentFromWorkflowForAffiliateUser, sendInstallmentFromWorkflowForFollower, sendInstallmentFromWorkflowForMemberCancellation, sendInstallmentFromWorkflowForPurchase, defaultSendDeps, type SendDeps } from "../../server/models/installment-send.ts";
import { defaultPostEmailDeps, type PostEmailDeps } from "../../server/models/post-email-api.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { NotPortedError, RISK_STATES } from "../../server/models/user.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";
import type { Installment } from "@prisma/client";

export class RuleNotCommittedError extends Error {
  constructor() {
    super("SendWorkflowInstallmentWorker::RuleNotCommittedError");
    this.name = "SendWorkflowInstallmentWorker::RuleNotCommittedError";
  }
}

// `present?` of a job argument.
function present(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// `with_primary_database(pinned)`
const withPrimary = <T>(pinned: boolean, fn: () => Promise<T>) => (pinned ? connectedTo("writing", fn) : fn());

// `current_rule_version(installment_id)`: the cached version, or (cache empty, pending, or unreadable) the rule's, read under
// a lock and cached. A Redis failure falls back to the rule's own version.
async function currentRuleVersion(installmentId: bigint, redis: Redis): Promise<number | null> {
  let cacheReadFailed = false;
  let pending = false;
  try {
    const [cached, isPending] = await cachedVersionState(installmentId, redis);
    pending = isPending;
    if (cached !== null && !pending) return cached;
  } catch {
    cacheReadFailed = true;
  }

  const effective = await connectedTo("writing", () =>
    transaction(async () => {
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`installment_rules`.*")} FROM ${table("installment_rules")} WHERE ${column("installment_rules", "installment_id")} = ${installmentId} LIMIT 1 FOR UPDATE`,
      );
      const rule = row === undefined ? null : castRow<InstallmentRule>("InstallmentRule", row);
      if (rule === null) return null;
      if (cacheReadFailed) return rule.version;
      try {
        return await cacheVersionBang(rule, redis);
      } catch {
        return rule.version;
      }
    }),
  );
  if (effective === null && pending) throw new RuleNotCommittedError();
  return effective;
}

async function findInstallmentAndRule(installmentId: bigint): Promise<[Installment | null, InstallmentRule | null]> {
  const installment = await findOneBy<Installment>("Installment", "id", installmentId, true);
  return [installment, installment === null ? null : await findOneBy<InstallmentRule>("InstallmentRule", "installment_id", installment.id)];
}

const isSuspended = (seller: User) => (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(seller.user_risk_state);

export const sendWorkflowInstallmentWorkerWith = (overrides: Partial<JobDeps> = {}, send: Partial<PostEmailDeps> & { subscriptionDeps?: SendDeps["subscriptionDeps"] } = {}) =>
  modelJob({ min: 4, max: 7 }, async (args, deps) => {
    const [installmentIdArg, versionArg, purchaseId, followerId, affiliateUserId = null, subscriptionId = null, referenceTimeArg = null] = args;
    const recipientIds = [purchaseId, followerId, affiliateUserId, subscriptionId];
    const rescheduleReferenceTime = recipientIds.filter(present).length === 1 ? referenceTimeArg : null;
    if (rescheduleReferenceTime !== null && rescheduleReferenceTime !== undefined && typeof rescheduleReferenceTime !== "string") {
      throw new HandBackToRuby(`a reschedule reference time that is not a String (${JSON.stringify(rescheduleReferenceTime)})`);
    }
    let reference: string | null = rescheduleReferenceTime ?? null;
    const sendDeps: SendDeps = { ...defaultSendDeps({ ...defaultPostEmailDeps(), now: deps.now, ...send }), ...(send.subscriptionDeps ? { subscriptionDeps: send.subscriptionDeps } : {}) };

    const { installmentId, version } = await beforeSideEffects(async () => {
      const id = recordIdFrom(installmentIdArg, "Installment.find_by");
      if (typeof versionArg !== "number") throw new NotPortedError(`a rule version that is not an Integer (${JSON.stringify(versionArg)})`, "send_workflow_installment_worker.rb");
      return { installmentId: id, version: versionArg };
    });
    const expectedRuleVersion = await currentRuleVersion(installmentId, send.redis?.() ?? getRedis("main"));
    if (expectedRuleVersion === null) return;

    let primaryPinned = expectedRuleVersion !== version || present(reference);
    let [installment, rule] = await withPrimary(primaryPinned, () => findInstallmentAndRule(installmentId));
    if (installment === null || rule === null || rule.version !== version) {
      primaryPinned = true;
      [installment, rule] = await withPrimary(true, () => findInstallmentAndRule(installmentId));
      if (installment === null || rule === null) return;
    }
    if (rule.version < expectedRuleVersion || rule.version < version) throw new RuleNotCommittedError();

    const post = new InstallmentPost(installment);
    post.preload("installment_rule", rule);
    await withPrimary(primaryPinned, async () => {
      const seller = await post.seller();
      if (seller !== null && isSuspended(seller)) return;
      // Follower and audience workflows of a retired newsletter stop here, including already scheduled jobs.
      if ((post.followerType || post.audienceType) && (await retiredFor(installment.seller_id))) return;
      const workflow = await post.workflow();
      if (workflow === null) throw new TypeError("undefined method 'alive?' for nil");
      if (workflow.row.deleted_at !== null) return;
      if (installment.deleted_at !== null) return;
      if (installment.published_at === null) return;

      // An out-of-date job re-checks the recipient against the current audience and reschedules itself.
      const ids: RecipientIds = { purchaseId, followerId, affiliateUserId, subscriptionId };
      const rescheduleDeps = { now: sendDeps.now, subscriptionDeps: sendDeps.subscriptionDeps };
      if (rule.version !== version) {
        const resolved = await beforeSideEffects(async () => {
          const current = await currentRecipientReferenceTime(post, ids, rescheduleDeps);
          if (reference === null || present(purchaseId)) reference = current;
          if (reference === null) return null;
          if (!(await recipientMatchesCurrentAudience(post, ids, reference, rescheduleDeps))) return null;
          return reference;
        });
        if (resolved !== null) await rescheduleWithCurrentRule(post, rule, version, ids, resolved);
        return;
      }
      if (present(purchaseId) && present(reference)) {
        const rescheduled = await beforeSideEffects(async () => {
          const current = await currentRecipientReferenceTime(post, ids, rescheduleDeps);
          if (current === null || !present(current) || current === reference) return "unchanged" as const;
          return (await recipientMatchesCurrentAudience(post, ids, current, rescheduleDeps)) ? current : null;
        });
        if (rescheduled !== "unchanged") {
          if (rescheduled !== null) await rescheduleWithCurrentRule(post, rule, version, ids, rescheduled);
          return;
        }
      }
      if (present(reference)) {
        if (!(await beforeSideEffects(() => recipientMatchesCurrentAudience(post, ids, reference!, rescheduleDeps)))) return;
      }

      if (present(purchaseId) && !present(followerId) && !present(affiliateUserId) && !present(subscriptionId)) {
        await sendInstallmentFromWorkflowForPurchase(post, recordIdFrom(purchaseId, "Purchase.find"), reference, sendDeps);
      } else if (present(followerId) && !present(purchaseId) && !present(affiliateUserId) && !present(subscriptionId)) {
        await sendInstallmentFromWorkflowForFollower(post, Number(recordIdFrom(followerId, "Follower.find_by")), sendDeps);
      } else if (present(affiliateUserId) && !present(purchaseId) && !present(followerId) && !present(subscriptionId)) {
        await sendInstallmentFromWorkflowForAffiliateUser(post, recordIdFrom(affiliateUserId, "User.find_by"), sendDeps);
      } else if (present(subscriptionId) && !present(purchaseId) && !present(followerId) && !present(affiliateUserId)) {
        await sendInstallmentFromWorkflowForMemberCancellation(post, recordIdFrom(subscriptionId, "Subscription.find"), sendDeps);
      } else {
        // Exactly one recipient id is expected; anything else is logged and sends nothing.
        sendDeps.log(
          `[SendWorkflowInstallmentWorker] installment_id=${String(installmentIdArg)} got an unusable recipient combination (purchase=${inspect(purchaseId)} follower=${inspect(followerId)} affiliate=${inspect(affiliateUserId)} subscription=${inspect(subscriptionId)}); nothing sent`,
        );
      }
    });
  })(overrides);

// Object#inspect of a job argument
function inspect(value: JsonValue | undefined): string {
  return value === null || value === undefined ? "nil" : JSON.stringify(value);
}

export const sendWorkflowInstallmentWorker = sendWorkflowInstallmentWorkerWith();
