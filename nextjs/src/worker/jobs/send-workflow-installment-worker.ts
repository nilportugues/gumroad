// Port of app/sidekiq/send_workflow_installment_worker.rb: sends one workflow installment to one recipient
// (a purchase, a follower, an affiliate user or a cancelled membership) if the rule it was scheduled under is
// still current, and the post is still sendable.
// Golden: __fixtures__/post-email-sends.golden.json (scripts/golden/post-email-sends.rb).
//
// Handed back to Rails, before the job's first write: a rule version Redis does not hold (or holds as pending),
// and every path that reschedules an out-of-date job (a version that moved, a reschedule reference time), which
// matches the recipient against the current audience (AudienceMember.filter).
import type { InstallmentRule, User } from "@prisma/client";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { cachedVersionState } from "../../server/models/installment-rule.ts";
import { InstallmentPost } from "../../server/models/installment-post.ts";
import { retiredFor, sendInstallmentFromWorkflowForAffiliateUser, sendInstallmentFromWorkflowForFollower, sendInstallmentFromWorkflowForMemberCancellation, sendInstallmentFromWorkflowForPurchase, defaultSendDeps, type SendDeps } from "../../server/models/installment-send.ts";
import { defaultPostEmailDeps, type PostEmailDeps } from "../../server/models/post-email-api.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
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
    const sendDeps: SendDeps = { ...defaultSendDeps({ ...defaultPostEmailDeps(), now: deps.now, ...send }), ...(send.subscriptionDeps ? { subscriptionDeps: send.subscriptionDeps } : {}) };

    const { installmentId, expectedRuleVersion, version } = await beforeSideEffects(async () => {
      const id = recordIdFrom(installmentIdArg, "Installment.find_by");
      if (typeof versionArg !== "number") throw new NotPortedError(`a rule version that is not an Integer (${JSON.stringify(versionArg)})`, "send_workflow_installment_worker.rb");
      let cached: [number | null, boolean];
      try {
        cached = await cachedVersionState(id, send.redis?.() ?? getRedis("main"));
      } catch {
        throw new NotPortedError("InstallmentRule.cache_version! after a failed cache read", "send_workflow_installment_worker.rb:62");
      }
      // A rule the cache does not hold (or holds as a pending write) is read under a lock and cached: that is Ruby's.
      if (cached[0] === null || cached[1]) throw new NotPortedError("InstallmentRule.cache_version!", "send_workflow_installment_worker.rb:62");
      return { installmentId: id, expectedRuleVersion: cached[0], version: versionArg };
    });

    let primaryPinned = expectedRuleVersion !== version || present(rescheduleReferenceTime);
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
      if (rule.version !== version || present(rescheduleReferenceTime)) {
        throw new HandBackToRuby("rescheduling a workflow installment against the current audience (AudienceMember.filter)");
      }

      if (present(purchaseId) && !present(followerId) && !present(affiliateUserId) && !present(subscriptionId)) {
        await sendInstallmentFromWorkflowForPurchase(post, recordIdFrom(purchaseId, "Purchase.find"), null, sendDeps);
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
