// Port of app/sidekiq/alert_on_stuck_piracy_reports_job.rb, up to the alert: the six reads (reports blocked on a recipient, waiting
// for review, whose delivery failed or went unconfirmed, signed and unsent while :piracy_reports_sending is on, never screened, and
// sellers with repeated counter-notices). A run where nothing is waiting for a person finishes here. A run with something to report
// builds a message from PiracyReports::SendService reasons and pushes it, so it hands back after the reads; nothing has been written.
// A sending feature on a partial percentage of time (Flipper rolls per call) or with an expression gate hands back too.
// Golden: __fixtures__/alert-on-stuck-piracy-reports-job.golden.json (scripts/golden/alert-on-stuck-piracy-reports-job.rb).
import { Prisma } from "@prisma/client";

import { parseGateValues, readFeatureDoc } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { selectRows } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const MAX_REPORTED = 25;
const UNSENT_GRACE = { hours: 1 };
const REPEAT_COUNTER_NOTICES = 2;
const REPEAT_COUNTER_NOTICE_WINDOW = { days: 90 };
const UNSCREENED_GRACE = { hours: 6 };
const DELIVERY_CONFIRMATION_WINDOW = { hours: 24 };
const SENDING_FEATURE = "piracy_reports_sending";
const PERCENT = 100;

const LIMIT = MAX_REPORTED + 1;
const reports = (condition: Prisma.Sql) =>
  selectRows(
    Prisma.sql`SELECT \`piracy_reports\`.* FROM \`piracy_reports\` WHERE ${condition} ORDER BY \`piracy_reports\`.\`id\` ASC LIMIT ${Prisma.raw(String(LIMIT))}`,
  );
const raw = (text: string) => Prisma.raw(text);

// Feature.active?(:piracy_reports_sending) with no actor: the boolean gate, or a percentage of time that is always open.
async function sendingEnabled(redis: FeatureRedis): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(SENDING_FEATURE, redis as never));
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null)
    throw new HandBackToRuby(`${SENDING_FEATURE} uses an expression gate`);
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT)
    throw new HandBackToRuby(`${SENDING_FEATURE} is enabled for a percentage of time`);
  return values.percentageOfTime >= PERCENT;
}

export type FeatureRedis = { hgetall(key: string): Promise<Record<string, string>> };

export const alertOnStuckPiracyReportsJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: { redis?: () => FeatureRedis } = {},
) =>
  modelJob({ min: 0 }, async (_args, deps) => {
    const redis = (extras.redis ?? (() => getRedis("main") as unknown as FeatureRedis))();
    const now = deps.now();
    const blocked = await reports(
      raw("`piracy_reports`.`state` = 'screening' AND `piracy_reports`.`screening_verdict` = 'pass'"),
    );
    const review = await reports(
      raw("`piracy_reports`.`state` = 'screening' AND `piracy_reports`.`screening_verdict` = 'review'"),
    );
    const undelivered = await reports(
      Prisma.sql`\`piracy_reports\`.\`state\` = 'sent' AND \`piracy_reports\`.\`delivered_at\` IS NULL AND (\`piracy_reports\`.\`delivery_failed_at\` IS NOT NULL OR \`piracy_reports\`.\`delivery_failed_at\` IS NULL AND \`piracy_reports\`.\`sent_at\` < ${ago(DELIVERY_CONFIRMATION_WINDOW, now)})`,
    );
    const unsent = (await sendingEnabled(redis))
      ? await reports(
          Prisma.sql`\`piracy_reports\`.\`state\` = 'signed' AND \`piracy_reports\`.\`signed_at\` < ${ago(UNSENT_GRACE, now)}`,
        )
      : [];
    const unscreened = await reports(
      Prisma.sql`(\`piracy_reports\`.\`state\` = 'requested' OR \`piracy_reports\`.\`state\` = 'screening' AND \`piracy_reports\`.\`screening_verdict\` IS NULL) AND \`piracy_reports\`.\`updated_at\` < ${ago(UNSCREENED_GRACE, now)}`,
    );
    // `where(counter_notice_received_on: WINDOW.ago.to_date..)`; the HAVING bind is quoted as text.
    const since = ago(REPEAT_COUNTER_NOTICE_WINDOW, now).toISOString().slice(0, 10);
    const repeatSellers = await selectRows(
      Prisma.sql`SELECT COUNT(*) AS \`count_all\`, \`piracy_reports\`.\`seller_id\` AS \`piracy_reports_seller_id\` FROM \`piracy_reports\` WHERE \`piracy_reports\`.\`counter_notice_received_on\` >= ${since} GROUP BY \`piracy_reports\`.\`seller_id\` HAVING (COUNT(*) >= ${String(REPEAT_COUNTER_NOTICES)})`,
    );
    if ([blocked, review, undelivered, unsent, unscreened, repeatSellers].every((rows) => rows.length === 0)) return;

    throw new HandBackToRuby("the piracy alert is built from PiracyReports::SendService reasons");
  })(overrides);

export const alertOnStuckPiracyReportsJob = alertOnStuckPiracyReportsJobWith();
