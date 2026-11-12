// Port of app/sidekiq/send_signed_piracy_notices_job.rb up to PiracyReports::SendService. The `piracy_reports_sending` feature read
// and the scan for signed reports run in Node and finish a job with the feature off or nothing signed. A signed report means
// SendService (a locked state change and the mail), which hands back to Rails before anything is written; so does a feature Rails
// answers by chance (a partial percentage of time) or by an expression gate.
// Golden: __fixtures__/send-signed-piracy-notices-job.golden.json (scripts/golden/send-signed-piracy-notices-job.rb).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { evaluateFeature, parseGateValues, readFeatureDoc } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { column, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PIRACY_REPORTS_SENDING = "piracy_reports_sending";
const FIND_EACH_BATCH_SIZE = 1_000;
const PERCENT = 100;

// Feature.active?(name) with no actor.
async function featureActive(name: string, redis: Redis): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(name, redis));
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null)
    throw new HandBackToRuby(`${name} uses an expression gate`);
  // Rails rolls `rand` on every call for the time gate.
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT) {
    throw new HandBackToRuby(`${name} is enabled for a percentage of time`);
  }
  return evaluateFeature(name, values);
}

export const sendSignedPiracyNoticesJobWith = (redis: () => Redis = () => getRedis("main")) =>
  modelJob({ min: 0 }, async () => {
    if (!(await featureActive(PIRACY_REPORTS_SENDING, redis()))) return;

    const signed = Prisma.sql`${column("piracy_reports", "state")} = 'signed'`;
    await findInBatches("piracy_reports", signed, FIND_EACH_BATCH_SIZE, () => {
      throw new HandBackToRuby("a signed piracy report to send");
    });
  })();
export const sendSignedPiracyNoticesJob = sendSignedPiracyNoticesJobWith();
