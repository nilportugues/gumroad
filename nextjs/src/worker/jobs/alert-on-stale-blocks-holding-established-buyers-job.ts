// Port of app/sidekiq/alert_on_stale_blocks_holding_established_buyers_job.rb up to the first candidate block: the sweep cursor read
// from Redis, the scan of active email blocks past it and the cursor reset when a pass finds nothing run in Node, and a run with no
// block to judge ends there. A candidate block needs the settled-purchase counts, the sibling blocks and the unblock writes, so the
// job goes back to Rails whole before any write (the cursor reset is only written once the second scan came back empty).
// Golden: __fixtures__/alert-on-stale-blocks-holding-established-buyers-job.golden.json
// (scripts/golden/alert-on-stale-blocks-holding-established-buyers-job.rb).
import { Prisma } from "@prisma/client";

import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { rubyToI } from "../../server/mail/mailer-info.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";
import { redisOrHandBack } from "./support/redis-or-hand-back.ts";

const PLATFORM_BLOCKS = "platform_blocks";
const MAX_CANDIDATES_SCANNED = 5_000;
// RedisKey.stale_block_sweep_cursor
const CURSOR_KEY = "stale_block_sweep:cursor";
// PlatformBlock::TYPES[:email]
const BLOCK_TYPE = "email";

const blocks = (name: string) => column(PLATFORM_BLOCKS, name);

// The two Redis commands the cursor needs, on the main database (`$redis`).
export type StaleBlockRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: number): Promise<unknown>;
};
export type StaleBlockDeps = { redis: () => StaleBlockRedis };

// PlatformBlock.active.where(object_type: email, blocked_by: nil).where.not(object_value: nil).where("platform_blocks.id > ?", after_id)
// .order(id: :asc).limit(MAX_CANDIDATES_SCANNED + 1)
async function candidateBlocks(afterId: number, now: Date): Promise<unknown[]> {
  return selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table(PLATFORM_BLOCKS)} WHERE ${blocks("blocked_at")} IS NOT NULL AND (expires_at IS NULL OR expires_at > ${now}) AND ${blocks("object_type")} = ${BLOCK_TYPE} AND ${blocks("blocked_by")} IS NULL AND ${blocks("object_value")} IS NOT NULL AND (platform_blocks.id > ${String(afterId)}) ORDER BY ${blocks("id")} ASC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED + 1))}`,
  );
}

export const alertOnStaleBlocksHoldingEstablishedBuyersJobWith = (
  overrides: Partial<JobDeps> = {},
  stale: Partial<StaleBlockDeps> = {},
) =>
  modelJob({ min: 0, max: 0 }, async (_args, deps) => {
    const redis = (stale.redis ?? (() => getRedis("main")))();
    const afterId = rubyToI(await redisOrHandBack("reading the sweep cursor", () => redis.get(CURSOR_KEY)));

    const now = deps.now();
    let candidates = await candidateBlocks(afterId, now);
    const startOver = candidates.length === 0 && afterId > 0;
    if (startOver) candidates = await candidateBlocks(0, now);
    if (candidates.length > 0)
      throw new HandBackToRuby("a candidate block's buyer history is read and the block may be cleared");
    if (startOver) await redisOrHandBack("saving the sweep cursor", () => redis.set(CURSOR_KEY, 0));
  })(overrides);

export const alertOnStaleBlocksHoldingEstablishedBuyersJob = alertOnStaleBlocksHoldingEstablishedBuyersJobWith();
