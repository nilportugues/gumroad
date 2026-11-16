// Replays repair-order-charge-outcomes-job.golden.json (scripts/golden/repair-order-charge-outcomes-job.rb): RepairOrderChargeOutcomesJob
// run by the real app as a Sidekiq job. Production Sidekiq caps both the writing and the reading connection, so the golden carries each
// `max_execution_time` statement twice; Node has one pool and one cap, proven against Rails in
// server/models/runtime/max-execution-time.golden.test.ts. Here the cap statements are checked on their own and left out of the
// comparison of the rest.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setPinnedSessionFactory } from "../../server/models/runtime/max-execution-time.ts";
import { setSqlClient, type SqlClient } from "../../server/models/sql.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { repairOrderChargeOutcomesJobWith } from "./repair-order-charge-outcomes-job.ts";

// sqlReplay installs its client with setSqlClient; the block's connection delegates to it.
const replay = vi.hoisted(() => ({ client: null as null | (() => unknown) }));
vi.mock("../../server/models/sql.ts", async (original) => {
  const module = await original<typeof import("../../server/models/sql.ts")>();
  return {
    ...module,
    setSqlClient: (next: Parameters<typeof module.setSqlClient>[0]) => {
      replay.client = next as () => unknown;
      module.setSqlClient(next);
    },
  };
});

type Marks = Record<"cursor" | "lap_ceiling" | "recent_mark", string | null>;
type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  marks_before: Marks;
  marks: Marks;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/repair-order-charge-outcomes-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const KEYS: Record<keyof Marks, string> = {
  cursor: "order_charge_outcome_repair:cursor",
  lap_ceiling: "order_charge_outcome_repair:lap_ceiling",
  recent_mark: "order_charge_outcome_repair:recent_mark",
};
const isCap = (sql: string) => /^(select @@max_execution_time|set max_execution_time)/u.test(sql);
const names = Object.keys(KEYS) as (keyof Marks)[];

function pinnedThroughReplay(capLog: string[]) {
  setPinnedSessionFactory(() => {
    const inner = () => replay.client!() as SqlClient;
    const statement = (query: Prisma.Sql) => query.sql;
    return {
      client: {
        $queryRaw: async (query: Prisma.Sql) => {
          if (!isCap(statement(query))) return inner().$queryRaw(query);
          capLog.push(statement(query));
          return [{ "@@max_execution_time": 300000 }];
        },
        $executeRaw: async (query: Prisma.Sql) => {
          if (!isCap(statement(query))) return inner().$executeRaw(query);
          capLog.push(statement(query));
          return 0;
        },
        $transaction: async () => {
          throw new Error("the job opens no transaction");
        },
      } as never,
      close: async () => undefined,
    };
  });
}

function fakeMarks(initial: Marks) {
  const store = new Map<string, string>();
  for (const name of names) if (initial[name] !== null) store.set(KEYS[name], initial[name]!);
  const sets: string[] = [];
  return {
    store,
    sets,
    redisGet: async (key: string) => store.get(key) ?? null,
    redisSet: async (key: string, value: string) => {
      sets.push(key);
      store.set(key, value);
    },
    marks: (): Marks => Object.fromEntries(names.map((name) => [name, store.get(KEYS[name]) ?? null])) as Marks,
  };
}

async function run(c: Case, redis: ReturnType<typeof fakeMarks>) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(c.statements.filter((s) => !isCap(s.sql)));
  const capLog: string[] = [];
  pinnedThroughReplay(capLog);
  const handler = repairOrderChargeOutcomesJobWith({
    now: () => new Date(Math.round(golden.now * 1000)),
    redisGet: redis.redisGet,
    redisSet: redis.redisSet,
    notify: () => undefined,
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([] as JsonValue[], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, capLog, recording };
}

describe("RepairOrderChargeOutcomesJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const redis = fakeMarks(c.marks_before);
      const { error, sql, capLog, recording } = await run(c, redis);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(redis.marks()).toEqual(c.marks);
      expect(capLog).toEqual([
        "select @@max_execution_time",
        "set max_execution_time = 120000",
        "set max_execution_time = 300000",
      ]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("takes no argument", async () => {
    const handler = repairOrderChargeOutcomesJobWith({ redisGet: async () => null, redisSet: async () => undefined });
    await expect(
      handler(
        [1],
        contextFor(
          createJobsRuntime({
            sidekiqRedis: recordingSidekiqRedis().redis,
            bullmqRedis: recordingSidekiqRedis().redis,
            registry: rubyRuntimeRegistry(),
            now: () => golden.now,
            newJid: sequentialJids(),
          }),
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("RepairOrderChargeOutcomesJob handing back", () => {
  const sqlAnswering = (answer: (sql: string) => unknown[]) => {
    const client = {
      $queryRaw: async (query: Prisma.Sql) => answer(query.sql),
      $executeRaw: async () => 0,
    };
    setSqlClient(() => client as never);
    setPinnedSessionFactory(() => ({ client: client as never, close: async () => undefined }));
  };
  const perform = (redis: {
    redisGet: (key: string) => Promise<string | null>;
    redisSet: (k: string, v: string) => Promise<void>;
  }) =>
    repairOrderChargeOutcomesJobWith(redis)(
      [],
      contextFor(
        createJobsRuntime({
          sidekiqRedis: recordingSidekiqRedis().redis,
          bullmqRedis: recordingSidekiqRedis().redis,
          registry: rubyRuntimeRegistry(),
          now: () => golden.now,
          newJid: sequentialJids(),
        }),
      ),
    );

  it("hands back before any Redis write when a Redis read fails", async () => {
    sqlAnswering(() => []);
    const sets: string[] = [];
    await expect(
      perform({
        redisGet: async () => {
          throw new Error("connection refused");
        },
        redisSet: async (key) => void sets.push(key),
      }),
    ).rejects.toBeInstanceOf(HandBackToRuby);
    expect(sets).toEqual([]);
  });

  it("hands back before any Redis write when the recent walk keeps finding full pages", async () => {
    let next = 1;
    sqlAnswering((sql) => {
      if (sql.includes("SELECT `purchases`.`id` FROM"))
        return Array.from({ length: 1000 }, () => ({ id: BigInt(next++) }));
      if (sql.startsWith("select @@")) return [{ "@@max_execution_time": 0 }];
      return [];
    });
    const sets: string[] = [];
    await expect(
      perform({ redisGet: async () => "5", redisSet: async (key) => void sets.push(key) }),
    ).rejects.toBeInstanceOf(HandBackToRuby);
    expect(sets).toEqual([]);
  });

  it("hands back without writing the lap ceiling it computed when the backlog walk keeps finding full pages", async () => {
    let next = 1;
    sqlAnswering((sql) => {
      if (sql.startsWith("SELECT MAX(`orders`.`id`)")) return [{ "MAX(`orders`.`id`)": 9n }];
      if (sql.includes("(order_purchases.order_id >"))
        return Array.from({ length: 1000 }, () => ({ order_id: BigInt(next++) }));
      return [];
    });
    const sets: string[] = [];
    await expect(
      perform({ redisGet: async () => null, redisSet: async (key) => void sets.push(key) }),
    ).rejects.toBeInstanceOf(HandBackToRuby);
    expect(sets).toEqual([]);
  });
});
