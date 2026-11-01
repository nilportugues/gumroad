// Replays user-writes.golden.json (scripts/golden/user-writes.rb): the real User model, booted
// with the whole app against MySQL, saved, locked and moved through its risk states. Node must send
// the statements Rails sent, given the same answers, and leave the same Sidekiq and cache state.
// Cases that take unique-jobs locks need JOBS_REDIS_URL (a scratch database), and are skipped
// without it.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../search/__fixtures__/job-harness.ts";
import { recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { withJobsRuntime } from "./concerns/job-runtime.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "./link.ts";
import { execute } from "./sql.ts";
import { setSellerProfileCacheForTesting } from "./seller-profile.ts";
import { fireRiskEvent, fireRiskEventBang, resetRiskCollaborators, setRiskCollaborators, type RiskEvent, type TransitionParams } from "./user-risk.ts";
import { findUserBang, resetUserCollaborators, setFlag, setJsonDataForAttr, setUserCollaborators, Users } from "./user.ts";

export type UserWritesCase = {
  name: string;
  seed: string[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
  rows: Record<string, { fields: string[]; rows: JsonValue[][] }>;
  es?: { method: string; path: string; query: string | null; body: string | null }[];
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
  "flag_for_fraud! comments and adds the gmail variant to the abuse filter": fire("flag_for_fraud", { author_name: "check_payment_address" }),
  "flag_for_tos_violation! in bulk, authored by an admin": fire("flag_for_tos_violation", { author_id: 7, bulk: true }),
  "flag_for_tos_violation! for one product comments on it": fire("flag_for_tos_violation", { author_name: "iffy", product_id: 9 }),
  "put_on_probation! with custom content": fire("put_on_probation", { author_name: "iffy", content: "Held for review" }),
  "mark_not_reviewed! from probation": fire("mark_not_reviewed", { author_name: "iffy" }),
  "mark_compliant! from flagged enables refunds and lifts the platform pause after commit": fire("mark_compliant", { author_name: "iffy" }),
  "mark_compliant! rebases flags onto the locked row": async () => {
    const user = await findUserBang(5);
    await execute(Prisma.sql`UPDATE \`users\` SET \`users\`.\`flags\` = 128 WHERE \`users\`.\`id\` = 5`);
    await fireRiskEventBang(user, "mark_compliant", { author_name: "iffy" }, { now });
  },
  "mark_compliant! records hold_released once per offer": fire("mark_compliant", { author_name: "iffy" }),
  "mark_compliant! clearing a suspension unblocks the IP, re-adds the Apple Pay domain and releases cascade siblings": fire("mark_compliant", {
    author_name: "iffy",
    clear_suspension: true,
  }),
  "mark_compliant! releases siblings that share a bank account fingerprint": fire("mark_compliant", { author_id: 5, clear_suspension: true }),
  "mark_compliant! refuses to clear a suspension the caller did not authorize": async () => {
    const user = await findUserBang(5);
    await execute(Prisma.sql`UPDATE \`users\` SET \`users\`.\`user_risk_state\` = 'suspended_for_tos_violation' WHERE \`users\`.\`id\` = 5`);
    await fireRiskEventBang(user, "mark_compliant", { author_name: "iffy" }, { now });
  },
  "suspend_for_fraud! revokes mobile sessions, bans products, deletes the custom domain and schedules the cascade": fire("suspend_for_fraud", { author_name: "iffy" }),
  "suspend_for_tos_violation! from the account cascade skips its own job and filters the gmail address": fire("suspend_for_tos_violation", {
    author_name: "suspend_sellers_other_accounts",
    skip_transition_callback: "suspend_sellers_other_accounts",
  }),
  "suspend_for_fraud! rolls back when the custom domain is not unique": fire("suspend_for_fraud", { author_name: "iffy" }),
  "suspend_for_fraud! rolls back when a product raises": fire("suspend_for_fraud", { author_name: "iffy" }),
  "a verified seller cannot be suspended": fire("suspend_for_fraud", { author_name: "iffy" }),
  "mark_compliant! clearing a suspension unbans deleted products too": fire("mark_compliant", { author_name: "iffy", clear_suspension: true }),
  "mark_compliant! records hold_released for each currently linked provider": fire("mark_compliant", { author_name: "iffy" }),
  "mark_compliant! records hold_released once when no verification is linked": fire("mark_compliant", { author_name: "iffy" }),
  "an event with no transition from the current state": fire("mark_not_reviewed", { author_name: "iffy" }),
  "a verified seller cannot be flagged": fire("flag_for_fraud", { author_name: "iffy" }),
  "a transition without an author rolls back": fire("flag_for_fraud"),
  "the non-bang event returns false and adds an error": async () => {
    const user = await findUserBang(5);
    const result = await fireRiskEvent(user, "mark_not_reviewed", { author_name: "iffy" }, { now });
    const detail = user.errors.details.find((d) => d.attribute === "user_risk_state")!;
    throw new Error(
      `[${String(result)}, [{error: :invalid_transition, event: ${JSON.stringify(detail.options.event)}, state: ${JSON.stringify(detail.options.state)}}], ${JSON.stringify(user.errors.fullMessages())}]`,
    );
  },
};

function fire(event: RiskEvent, params?: TransitionParams) {
  return async () => fireRiskEventBang(await findUserBang(5), event, params, { now });
}

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
afterEach(() => {
  resetUserCollaborators();
  resetRiskCollaborators();
  resetLinkCollaborators();
});

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
      // No case turns on a Flipper gate or reads $redis through a product save.
      setLinkCollaborators({
        isFeatureEnabled: async () => false,
        redis: () => {
          throw new Error("unexpected $redis read");
        },
        cacheDelete: async (name) => void cache.push(["cache_delete", name]),
      });
      const es = esRecorder();
      process.env.MOBILE_API_OAUTH_APPLICATION_UID = "test-mobile-api-oauth-app-uid";
      setRiskCollaborators({
        sadd: (key, member) => sidekiqRedis.pipeline().sadd(key, member).exec(),
        srem: (key, member) => sidekiqRedis.pipeline().srem(key, member).exec(),
      });
      let error: unknown = null;
      try {
        await withJobsRuntime(runtime, USER_WRITE_ACTIONS[c.name]!);
      } catch (e) {
        error = e;
      } finally {
        es.restore();
      }
      expect(sql.log).toEqual(sql.expected);
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(cache).toEqual(c.cache);
      expect(es.requests).toEqual(c.es ?? []);
      expect(await snapshot()).toEqual(c.redis);
    });
  }
});
