// The slice of ioredis the `ratelimit` port (server/services/ratelimit.ts) uses, in memory, with a snapshot in the shape
// golden.ts#snapshotRedis gives so a job golden can compare Rails' rate-limit hashes. A test file mocks `server/infra/redis.ts` with it:
//   vi.mock("../../server/infra/redis.ts", async () => ({ getRedis: (await import("./__fixtures__/ratelimit-redis.ts")).getRedis }));
import type { RedisSnapshot } from "./golden.ts";

const hashes = new Map<string, Map<string, number>>();
const expiring = new Set<string>();

const fakeRedis = {
  multi: () => {
    const calls: (() => number)[] = [];
    const chain = {
      hincrby: (key: string, field: string, count: number) => {
        calls.push(() => {
          const hash = hashes.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + count);
          hashes.set(key, hash);
          return hash.get(field)!;
        });
        return chain;
      },
      expire: (key: string) => {
        calls.push(() => Number(expiring.add(key).size));
        return chain;
      },
      exec: () => Promise.resolve(calls.map((call) => [null, call()])),
    };
    return chain;
  },
  hmget: (key: string, ...fields: string[]) =>
    Promise.resolve(
      fields.map((field) => hashes.get(key)?.get(field)).map((v) => (v === undefined ? null : String(v))),
    ),
  hkeys: (key: string) => Promise.resolve([...(hashes.get(key)?.keys() ?? [])]),
  hdel: () => Promise.resolve(0),
};

export const getRedis = () => fakeRedis;

export function resetRatelimitRedis(): void {
  hashes.clear();
  expiring.clear();
}

export function ratelimitSnapshot(): RedisSnapshot {
  return Object.fromEntries(
    [...hashes].map(([key, hash]) => [
      key,
      {
        type: "hash",
        value: Object.fromEntries([...hash].map(([field, count]) => [field, String(count)])),
        expires: expiring.has(key),
      },
    ]),
  ) as unknown as RedisSnapshot;
}
