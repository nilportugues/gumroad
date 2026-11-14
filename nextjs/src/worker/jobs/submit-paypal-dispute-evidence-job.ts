// Port of app/sidekiq/submit_paypal_dispute_evidence_job.rb up to the dispute's purchases. The feature flag and the four guards that read the
// dispute row (not PayPal, no processor dispute id, already won or lost) run in Node and end the job. A dispute that passes them reads the
// purchases and their access log, then PayPal, and takes a Redis claim before it posts a note that cannot be withdrawn, so it goes back to
// Rails whole before that. A feature on a partial percentage of time (Flipper rolls per call), one with an expression gate, and an id Rails
// casts go back too.
// Golden: __fixtures__/submit-paypal-dispute-evidence-job.golden.json (scripts/golden/submit-paypal-dispute-evidence-job.rb).
import { parseGateValues, readFeatureDoc } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const FEATURE_FLAG = "submit_paypal_dispute_evidence";
const PAYPAL = "paypal";
const PERCENT = 100;

export type FeatureRedis = { hgetall(key: string): Promise<Record<string, string>> };

// Feature.active?(:submit_paypal_dispute_evidence) with no actor: the boolean gate, or a percentage of time that is always open.
async function featureActive(redis: FeatureRedis): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(FEATURE_FLAG, redis as never));
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null)
    throw new HandBackToRuby(`${FEATURE_FLAG} uses an expression gate`);
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT)
    throw new HandBackToRuby(`${FEATURE_FLAG} is enabled for a percentage of time`);
  return values.percentageOfTime >= PERCENT;
}

type Dispute = {
  charge_processor_id: string | null;
  charge_processor_dispute_id: string | null;
  won_at: Date | null;
  lost_at: Date | null;
};

export const submitPaypalDisputeEvidenceJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: { redis?: () => FeatureRedis } = {},
) =>
  modelJob({ min: 1 }, async ([disputeId]) => {
    const redis = (extras.redis ?? (() => getRedis("main") as unknown as FeatureRedis))();
    if (!(await featureActive(redis))) return;

    if (disputeId === null) throw new RecordNotFound("Couldn't find Dispute without an ID");
    const id = await beforeSideEffects(() => recordIdFrom(disputeId, "Dispute.find"));
    const dispute = await findByIdBang<Dispute & Record<string, unknown>>("Dispute", id);
    if (dispute.charge_processor_id !== PAYPAL) return;
    // `blank?`
    if (dispute.charge_processor_dispute_id === null || dispute.charge_processor_dispute_id.trim() === "") return;
    if (dispute.won_at !== null || dispute.lost_at !== null) return;

    throw new HandBackToRuby("the dispute's purchases, access log and PayPal case are read and a note is posted");
  })(overrides);
export const submitPaypalDisputeEvidenceJob = submitPaypalDisputeEvidenceJobWith();
