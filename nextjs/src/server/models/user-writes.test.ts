// Replays user-writes.golden.json (scripts/golden/user-writes.rb): the real User model, booted
// with the whole app against MySQL, saved, locked and moved through its risk states. Node must send
// the statements Rails sent, given the same answers, and leave the same Sidekiq and cache state.
// Cases that take unique-jobs locks need JOBS_REDIS_URL (a scratch database), and are skipped
// without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { setSellerProfileCacheForTesting } from "./seller-profile.ts";
import { findUserBang, resetUserCollaborators, setFlag, setJsonDataForAttr, setUserCollaborators, Users } from "./user.ts";

export type UserWritesCase = {
  name: string;
  seed: string[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
  rows: Record<string, { fields: string[]; rows: JsonValue[][] }>;
};
export const userWritesGolden = parseRubyJson(readFileSync(new URL("./__fixtures__/user-writes.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  cases: UserWritesCase[];
};
const now = () => new Date(Math.round(userWritesGolden.now * 1000));

// What each Ruby case did, in Node.
export const USER_WRITE_ACTIONS: Record<string, () => Promise<unknown>> = {
  "update! of a flag and a json_data accessor": async () => {
    const user = await findUserBang(5);
    setFlag(user, "payouts_paused_internally", false);
    setJsonDataForAttr(user, "payouts_paused_by", null);
    await Users.saveBang(user, { now });
  },
  "update! of an attribute that loads the seller profile": async () => {
    await Users.updateBang(await findUserBang(5), { payment_address: "paypal5@example.com" }, { now });
  },
  "a second save of the same instance inserts the built seller profile": async () => {
    const user = await findUserBang(5);
    await Users.updateBang(user, { payment_address: "paypal5@example.com" }, { now });
    await Users.updateBang(user, { bio: "Hello" }, { now });
  },
  "an existing seller profile is loaded, not built": async () => {
    const user = await findUserBang(5);
    await Users.updateBang(user, { payment_address: "paypal5@example.com" }, { now });
    await Users.updateBang(user, { bio: "Hello" }, { now });
  },
  "with_lock reloads the row FOR UPDATE and saves inside": async () => {
    const user = await findUserBang(5);
    await Users.withLock(user, async () => {
      setFlag(user, "payouts_paused_internally", false);
      setJsonDataForAttr(user, "payouts_paused_by", null);
      await Users.saveBang(user, { now });
    });
  },
  "with_lock refuses a record with unsaved changes": async () => {
    const user = await findUserBang(5);
    user.set("name", "Changed");
    await Users.withLock(user, () => Users.updateBang(user, { bio: "never" }, { now }));
  },
  "save without changes still runs the update callbacks": async () => {
    await Users.saveBang(await findUserBang(5), { now });
  },
  "an invalid update rolls back": async () => {
    await Users.updateBang(await findUserBang(5), { name: "a:b" }, { now });
  },
};

const takesLocks = (c: UserWritesCase) => Object.keys(c.redis).some((key) => key.startsWith("uniquejobs"));
const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;

beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});
afterEach(() => resetUserCollaborators());

describe("User writes", () => {
  for (const c of userWritesGolden.cases) {
    it.skipIf(takesLocks(c) && !url)(c.name, async () => {
      const sql = sqlReplay(c.statements);
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (takesLocks(c)) {
        await realRedis!.flushdb();
        sidekiqRedis = realRedis!;
        snapshot = () => snapshotRedis(realRedis!);
      } else {
        const recording = recordingSidekiqRedis();
        sidekiqRedis = recording.redis;
        snapshot = async () => recording.snapshot();
      }
      const runtime = createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry: rubyRuntimeRegistry(), now: () => userWritesGolden.now, newJid: sequentialJids() });
      const cache: [string, string][] = [];
      setSellerProfileCacheForTesting({ delete: async (name) => void cache.push(["cache_delete", name]) });
      setUserCollaborators({ now });
      let error: unknown = null;
      try {
        await withJobsRuntime(runtime, USER_WRITE_ACTIONS[c.name]!);
      } catch (e) {
        error = e;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(cache).toEqual(c.cache);
      expect(await snapshot()).toEqual(c.redis);
    });
  }
});
