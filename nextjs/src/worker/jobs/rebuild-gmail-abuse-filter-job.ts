// Port of app/sidekiq/rebuild_gmail_abuse_filter_job.rb and GmailAbuseFilter.rebuild!: the normalized addresses of abusive Gmail users
// are collected in a temporary Redis set that then replaces the live one. RENAME fails when nobody qualifies, so the job raises and
// leaves the old set in place, as Rails does.
// Golden: __fixtures__/rebuild-gmail-abuse-filter-job.golden.json (scripts/golden/rebuild-gmail-abuse-filter-job.rb).
import { Prisma } from "@prisma/client";

import { getRedis } from "../../server/infra/redis.ts";
import { columnIn, findInBatches, inList } from "../../server/models/sql.ts";
import { normalizeGmailAddress } from "../../server/models/user.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const USERS = "users";
const BATCH_SIZE = 1_000;
const REDIS_KEY = "gmail_abuse:normalized_emails";
const TEMP_KEY = `${REDIS_KEY}:rebuild`;
const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const ABUSIVE_RISK_STATES = [
  "suspended_for_fraud",
  "suspended_for_tos_violation",
  "flagged_for_fraud",
  "flagged_for_tos_violation",
];

type GmailFilterRedis = {
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
};
export type RebuildGmailAbuseFilterDeps = { redis: () => GmailFilterRedis };

export const rebuildGmailAbuseFilterJobWith = (
  deps: Partial<JobDeps> = {},
  rebuild: Partial<RebuildGmailAbuseFilterDeps> = {},
) =>
  modelJob({ min: 0 }, async () => {
    const redis = (rebuild.redis ?? (() => getRedis("main")))();
    try {
      await redis.del(TEMP_KEY);
      const where = Prisma.sql`${columnIn(USERS, "user_risk_state", ABUSIVE_RISK_STATES)} AND (LOWER(SUBSTRING_INDEX(email, '@', -1)) IN ${inList(GMAIL_DOMAINS)})`;
      await findInBatches<{ id: number; email: string }>(USERS, where, BATCH_SIZE, async (users) => {
        for (const user of users) {
          const normalized = normalizeGmailAddress(user.email);
          if (normalized !== null) await redis.sadd(TEMP_KEY, normalized);
        }
      });
      await redis.rename(TEMP_KEY, REDIS_KEY);
    } catch (error) {
      await redis.del(TEMP_KEY);
      throw error;
    }
  })(deps);

export const rebuildGmailAbuseFilterJob = rebuildGmailAbuseFilterJobWith();
