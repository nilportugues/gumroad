// Port of the enqueue side of app/sidekiq/reindex_seller_offer_codes_job.rb (`.enqueue` and `.enqueue_products`). The worker half lives in
// worker/jobs/reindex-seller-offer-codes-job.ts. Both run from after_commit callbacks of OfferCode, where a Redis outage must not fail the
// request: the index heals on the seller's next offer-code change, so a Redis error is logged and the enqueue skipped.
import { ReplyError } from "ioredis";

import { getRedis } from "../infra/redis.ts";

import { performAsync } from "./concerns/job-runtime.ts";

const REINDEX_JOB = "ReindexSellerOfferCodesJob";

const ENQUEUE_PRODUCTS_LUA = `local version = redis.call('INCR', KEYS[2])
for _, id in ipairs(ARGV) do
  redis.call('ZADD', KEYS[1], 'NX', version, id)
  redis.call('HSET', KEYS[3], id, version)
end
`;

// REDIS_TRANSPORT_ERRORS (config/redis.rb): the client's own errors, connection failures included.
const TRANSPORT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
function isRedisError(error: unknown): boolean {
  if (error instanceof ReplyError) return true;
  const { code, message } = error as { code?: string; message?: string };
  return (
    (code !== undefined && TRANSPORT_CODES.has(code)) ||
    /connection is closed|max retries per request/iu.test(message ?? "")
  );
}

async function skippingRedisErrors(sellerId: number | bigint, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!isRedisError(error)) throw error;
    console.warn(
      `Offer-code reindex enqueue skipped for seller ${String(sellerId)}: ${(error as Error).constructor.name}`,
    );
  }
}

// ReindexSellerOfferCodesJob.enqueue
export function enqueueSellerOfferCodesReindex(sellerId: number | bigint): Promise<void> {
  return skippingRedisErrors(sellerId, async () => {
    await getRedis("main").incr(`offer_code_index:${String(sellerId)}:version`);
    await performAsync(REINDEX_JOB, [Number(sellerId)]);
  });
}

// ReindexSellerOfferCodesJob.enqueue_products
export function enqueueProductsOfferCodesReindex(
  sellerId: number | bigint,
  productIds: (number | bigint)[],
): Promise<void> {
  if (productIds.length === 0) return Promise.resolve();
  return skippingRedisErrors(sellerId, async () => {
    const key = `offer_code_index:${String(sellerId)}`;
    await getRedis("main").eval(
      ENQUEUE_PRODUCTS_LUA,
      3,
      `${key}:products`,
      `${key}:sequence`,
      `${key}:product_versions`,
      ...productIds.map(String),
    );
    await performAsync(REINDEX_JOB, [Number(sellerId)]);
  });
}
