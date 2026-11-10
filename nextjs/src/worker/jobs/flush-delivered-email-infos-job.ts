// Port of app/sidekiq/flush_delivered_email_infos_job.rb and EmailInfo.flush_delivered_buffer!. Golden:
// __fixtures__/flush-delivered-email-infos-job.golden.json (scripts/golden/flush-delivered-email-infos-job.rb).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { column, columnIn, execute, table } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const EMAIL_INFOS = "email_infos";
const CREATOR_CONTACTING_CUSTOMERS_EMAIL_INFO = "CreatorContactingCustomersEmailInfo";
const BUFFER_KEY = "email_info:delivered_buffer";
const INFLIGHT_KEY = "email_info:delivered_inflight";
const LOCK_KEY = "email_info:delivered_flush_lock";
const MOVABLE_STATES = ["created", "sent"];
// Time.zone.at must stay in the years MySQL's DATETIME and Ruby's quoting write the same way.
const MAX_EPOCH = 253_402_300_799;

export const DELIVERED_BUFFER_CHUNK = 1000;
export const MAX_FLUSH_CHUNKS = 50;
export const FLUSH_LOCK_TTL_SECONDS = 10 * 60;

// EmailInfo::TAKE_CHUNK_LUA, RENEW_FLUSH_LOCK_LUA, ACK_INFLIGHT_LUA and RELEASE_FLUSH_LOCK_LUA
const TAKE_CHUNK_LUA = `
local items = redis.call("LRANGE", KEYS[1], 0, tonumber(ARGV[1]) - 1)
if #items == 0 then return {} end
redis.call("LTRIM", KEYS[1], #items, -1)
for i = 1, #items do
  redis.call("RPUSH", KEYS[2], items[i])
end
return items
`;
const RENEW_FLUSH_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
const ACK_INFLIGHT_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[2])
  return 1
end
return 0
`;
const RELEASE_FLUSH_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export type FlushEmailInfosDeps = {
  redis: () => Redis;
  chunk: number;
  maxChunks: number;
  // EmailInfo.renew_flush_lock!
  renewLock: (redis: Redis, token: string) => Promise<boolean>;
};

const renewFlushLock = async (redis: Redis, token: string): Promise<boolean> =>
  Number(await redis.eval(RENEW_FLUSH_LOCK_LUA, 1, LOCK_KEY, token, String(FLUSH_LOCK_TTL_SECONDS))) === 1;

type Delivery = { installmentId: number; purchaseId: number; deliveredAt: number };

// What the buffer's producers write is {"i":Integer,"p":Integer,"t":Integer}. Anything else would raise a Ruby-specific
// error or send a differently typed value, so the whole job goes back to Rails, which resumes this chunk from the inflight list.
function parseDelivery(raw: string): Delivery {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new NotPortedError("an unparseable delivered buffer entry", "email_info.rb");
  }
  const { i, p, t } = (record ?? {}) as Record<string, unknown>;
  if (
    typeof record !== "object" ||
    Array.isArray(record) ||
    !Number.isSafeInteger(i) ||
    !Number.isSafeInteger(p) ||
    !Number.isSafeInteger(t) ||
    (t as number) < 0 ||
    (t as number) > MAX_EPOCH
  )
    throw new NotPortedError("a delivered buffer entry that is not three integers", "email_info.rb");
  return { installmentId: i as number, purchaseId: p as number, deliveredAt: t as number };
}

// EmailInfo.apply_delivered_chunk!: one UPDATE per installment and slice of purchases. A late delivered callback never
// downgrades opened, and an existing delivered_at is overwritten only on a row that still moves. False when the lock was
// lost before an installment, which leaves the rest of the chunk in the inflight list.
async function applyDeliveredChunk(
  deliveries: Delivery[],
  slice: number,
  renew: () => Promise<boolean>,
): Promise<boolean> {
  const byInstallment = new Map<number, Delivery[]>();
  for (const delivery of deliveries)
    byInstallment.set(delivery.installmentId, [...(byInstallment.get(delivery.installmentId) ?? []), delivery]);

  for (const [installmentId, group] of byInstallment) {
    if (!(await renew())) return false;

    const earliest = new Map<number, number>();
    for (const { purchaseId, deliveredAt } of group)
      earliest.set(purchaseId, Math.min(earliest.get(purchaseId) ?? deliveredAt, deliveredAt));

    const entries = [...earliest];
    for (let start = 0; start < entries.length; start += slice) {
      const part = entries.slice(start, start + slice);
      // ActiveRecord quotes the purchase id of `WHEN ? THEN ?` as a string.
      const whens = Prisma.join(
        part.map(([purchaseId, epoch]) => Prisma.sql`WHEN ${String(purchaseId)} THEN ${new Date(epoch * 1000)}`),
        " ",
      );
      await execute(
        Prisma.sql`UPDATE ${table(EMAIL_INFOS)} SET state = 'delivered', delivered_at = CASE purchase_id ${whens} END WHERE ${column(EMAIL_INFOS, "type")} = ${CREATOR_CONTACTING_CUSTOMERS_EMAIL_INFO} AND ${columnIn(EMAIL_INFOS, "installment_id", [installmentId])} AND ${columnIn(
          EMAIL_INFOS,
          "purchase_id",
          part.map(([purchaseId]) => purchaseId),
        )} AND ${columnIn(EMAIL_INFOS, "state", MOVABLE_STATES)}`,
      );
    }
  }
  return true;
}

export const flushDeliveredEmailInfosJobWith = (
  overrides: Partial<JobDeps> = {},
  flush: Partial<FlushEmailInfosDeps> = {},
) => {
  const redis = flush.redis ?? (() => getRedis("main"));
  const chunk = flush.chunk ?? DELIVERED_BUFFER_CHUNK;
  const maxChunks = flush.maxChunks ?? MAX_FLUSH_CHUNKS;
  const renewLock = flush.renewLock ?? renewFlushLock;
  return modelJob({ min: 0 }, async (_args, deps) => {
    const client = redis();
    const token = deps.uuid();
    if ((await client.set(LOCK_KEY, token, "EX", FLUSH_LOCK_TTL_SECONDS, "NX")) === null) return;

    const renew = () => renewLock(client, token);
    try {
      let chunks = 0;
      for (;;) {
        if (chunks >= maxChunks) break;
        if (!(await renew())) break;

        let raw = await client.lrange(INFLIGHT_KEY, 0, -1);
        if (raw.length === 0) raw = (await client.eval(TAKE_CHUNK_LUA, 2, BUFFER_KEY, INFLIGHT_KEY, chunk)) as string[];
        if (raw.length === 0) break;

        const deliveries = await beforeSideEffects(() => raw.map(parseDelivery));
        if (!(await applyDeliveredChunk(deliveries, chunk, renew))) break;

        await client.eval(ACK_INFLIGHT_LUA, 2, LOCK_KEY, INFLIGHT_KEY, token);
        chunks += 1;
      }
    } finally {
      await client.eval(RELEASE_FLUSH_LOCK_LUA, 1, LOCK_KEY, token);
    }
  })(overrides);
};

export const flushDeliveredEmailInfosJob = flushDeliveredEmailInfosJobWith();
