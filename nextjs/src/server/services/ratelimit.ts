// The `ratelimit` gem (Ratelimit.new(key, redis: $redis)) on the same keys: a hash per subject, "ratelimit:<key>:<subject>", one field per
// five-second bucket holding the count, so a Rails worker and a Node one see each other's calls.
import { getRedis } from "../infra/redis.ts";

const BUCKET_SPAN = 600;
const BUCKET_INTERVAL = 5;
const BUCKET_EXPIRY = BUCKET_SPAN;
const CLEANUP_PROBABILITY = 0.01;
const MILLISECONDS_PER_SECOND = 1000;

const bucketOf = (seconds: number) => Math.floor(seconds / BUCKET_INTERVAL);
const nowSeconds = () => Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class Ratelimit {
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  private subjectKey(subject: string): string {
    return `ratelimit:${this.key}:${subject}`;
  }

  async add(subject: string, count = 1): Promise<number> {
    const redis = getRedis("main");
    const subjectKey = this.subjectKey(subject);
    if (Math.random() < CLEANUP_PROBABILITY) await this.cleanupExpiredBuckets(subjectKey);
    const replies = await redis
      .multi()
      .hincrby(subjectKey, String(bucketOf(nowSeconds())), count)
      .expire(subjectKey, BUCKET_EXPIRY + BUCKET_INTERVAL)
      .exec();
    return Number(replies?.[0]?.[1] ?? 0);
  }

  // The sum of the buckets after the one `interval` seconds ago, up to the current one.
  async count(subject: string, interval: number): Promise<number> {
    const window = Math.min(Math.max(interval, BUCKET_INTERVAL), BUCKET_SPAN);
    const oldest = bucketOf(nowSeconds() - window);
    const current = bucketOf(nowSeconds());
    const fields: string[] = [];
    for (let bucket = oldest + 1; bucket <= current; bucket += 1) fields.push(String(bucket));
    if (fields.length === 0) return 0;
    const values = await getRedis("main").hmget(this.subjectKey(subject), ...fields);
    return values.reduce((total, value) => total + (value === null ? 0 : Number(value)), 0);
  }

  async isExceeded(
    subject: string,
    { threshold, interval }: { threshold: number; interval: number },
  ): Promise<boolean> {
    return (await this.count(subject, interval)) >= threshold;
  }

  // Waits (as the gem does, a bucket at a time) until the subject is under its threshold, then runs the block.
  async execWithinThreshold<T>(
    subject: string,
    options: { threshold: number; interval: number },
    block: () => Promise<T>,
  ): Promise<T> {
    while (await this.isExceeded(subject, options)) await sleep(BUCKET_INTERVAL * MILLISECONDS_PER_SECOND);
    return block();
  }

  private async cleanupExpiredBuckets(subjectKey: string): Promise<void> {
    const redis = getRedis("main");
    const oldest = bucketOf(nowSeconds() - BUCKET_EXPIRY);
    const expired = (await redis.hkeys(subjectKey)).filter((field) => Number(field) < oldest);
    if (expired.length > 0) await redis.hdel(subjectKey, ...expired);
  }
}
