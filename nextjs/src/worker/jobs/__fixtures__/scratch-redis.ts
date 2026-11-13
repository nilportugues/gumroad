// The Redis commands a golden's `redis_before` can answer, over the keys the case started from: strings and sets, in the
// generator's snapshot shape. Anything the job sends beyond them is missing here and throws.
import type { RedisSnapshot } from "./golden.ts";

type Stored = RedisSnapshot[string];

export function scratchRedis(before: RedisSnapshot | undefined) {
  const store = new Map<string, Stored>(
    Object.entries(before ?? {}).map(([key, entry]) => [key, structuredClone(entry)]),
  );
  const commands: string[] = [];
  const redis = {
    get: (key: string) => {
      commands.push("get");
      return Promise.resolve((store.get(key)?.value as string | undefined) ?? null);
    },
    // `set key value` without expiry or conditions
    set: (key: string, value: number) => {
      commands.push("set");
      store.set(key, { type: "string", value: String(value), expires: false });
      return Promise.resolve("OK" as const);
    },
    // `srandmember key count`: every member while the set is no larger than the count
    srandmember: (key: string, count: number) => {
      commands.push("srandmember");
      const members = (store.get(key)?.value ?? []) as string[];
      if (members.length > count) throw new Error("a sample of a larger set is random");
      return Promise.resolve([...members]);
    },
  };
  const snapshot = (): RedisSnapshot => Object.fromEntries([...store].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { redis, snapshot, commands };
}
