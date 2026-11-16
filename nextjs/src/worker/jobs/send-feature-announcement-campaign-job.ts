// Port of app/sidekiq/send_feature_announcement_campaign_job.rb: one batch of a "sending" campaign's subscribers is queued as
// FeatureAnnouncementMailer#announcement (which stays in Ruby, so each ActiveJob push is built as `deliver_later(queue: "low")` builds
// it), then the job either schedules itself for the next batch or marks the campaign sent. A campaign id or cursor Rails would cast
// from anything but an Integer or its digits is handed back before any statement.
// Golden: __fixtures__/send-feature-announcement-campaign-job.golden.json (scripts/golden/send-feature-announcement-campaign-job.rb);
// cases with a `batch_size` ran with BATCH_SIZE lowered, which `batchSize` stands in for.
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { deliverLater, keywordArgs } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, columnIn, execute, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const BATCH_SIZE = 1_000;
const MAILER = "FeatureAnnouncementMailer";
const METHOD = "announcement";
const SUBSCRIPTIONS = "feature_announcement_subscriptions";
const CAMPAIGNS = "feature_announcement_campaigns";
const USERS = "users";

export type Deps = { batchSize: number };

function castableId(value: JsonValue | undefined, what: string): bigint {
  const castable =
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && /^[0-9]{1,15}$/u.test(value));
  if (!castable) throw new HandBackToRuby(`${what} is not an Integer`);
  return recordIdFrom(value, what);
}

export function sendFeatureAnnouncementCampaignJobWith(overrides: Partial<Deps> = {}) {
  const { batchSize }: Deps = { batchSize: BATCH_SIZE, ...overrides };
  return modelJob({ min: 1, max: 2 }, async (args, jobDeps, { runtime }) => {
    const [rawCampaignId, rawCursor = 0] = args;
    const campaignId = castableId(rawCampaignId, "the campaign id");
    const cursor = castableId(rawCursor, "the cursor");

    const campaign = await findByIdBang<{ key: string; state: string }>("FeatureAnnouncementCampaign", campaignId);
    if (campaign.state !== "sending") return;

    // `where("id > ?", cursor)` quotes the cursor as a string.
    const batch = await selectRows<{ id: bigint | number; user_id: bigint | number }>(
      Prisma.sql`SELECT ${column(SUBSCRIPTIONS, "id")}, ${column(SUBSCRIPTIONS, "user_id")} FROM ${table(SUBSCRIPTIONS)} WHERE ${column(SUBSCRIPTIONS, "subscribed")} = TRUE AND (id > ${String(cursor)}) ORDER BY ${column(SUBSCRIPTIONS, "id")} ASC LIMIT ${Prisma.raw(String(batchSize))}`,
    );

    const userIds = batch.map((row) => row.user_id);
    const users =
      userIds.length === 0
        ? []
        : await selectRows<{ id: bigint | number; email: string | null }>(
            Prisma.sql`SELECT ${column(USERS, "id")}, ${column(USERS, "email")} FROM ${table(USERS)} WHERE ${columnIn(USERS, "id", userIds)}`,
          );
    for (const user of users) {
      await deliverLater(
        runtime,
        {
          mailer: MAILER,
          method: METHOD,
          args: [keywordArgs({ campaign: campaign.key, user_id: Number(user.id), email: user.email })],
          queue: "low",
        },
        mailRoute(MAILER, METHOD),
      );
    }

    if (batch.length === batchSize) {
      await performAsync("SendFeatureAnnouncementCampaignJob", [rawCampaignId!, Number(batch.at(-1)!.id)]);
    } else {
      await execute(
        Prisma.sql`UPDATE ${table(CAMPAIGNS)} SET ${column(CAMPAIGNS, "state")} = 'sent', ${column(CAMPAIGNS, "updated_at")} = ${jobDeps.now()} WHERE ${column(CAMPAIGNS, "id")} = ${campaignId} AND ${column(CAMPAIGNS, "state")} = 'sending'`,
      );
    }
  });
}

export const sendFeatureAnnouncementCampaignJob = sendFeatureAnnouncementCampaignJobWith()();
