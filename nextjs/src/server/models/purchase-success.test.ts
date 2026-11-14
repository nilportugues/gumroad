// Replays the rest of the free purchase in purchase-create.golden.json (scripts/golden/purchase-create.rb): after the create,
// Order::ChargeService marks the purchase successful. Node must send the statements and pushes the jobs Rails did, in the
// order Rails did, and read Redis and Flipper in the same order, given the answers MySQL, Redis and Flipper gave Rails.
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import {
  buildPurchase,
  firstSaveSpan,
  golden,
  isSql,
  NOW,
  type Entry,
  type GoldenCase,
} from "./__fixtures__/purchase-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import type { CheckoutEffects } from "./checkout-effects.ts";
import { withPaperTrailRequest } from "./concerns/paper-trail.ts";
import { type PurchaseContext, Purchases } from "./purchase-create.ts";
import { markFreePurchaseSuccessful } from "./purchase-success.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { setUrlRedirectTokenGenerator } from "./url-redirect.ts";
import { NotPortedError } from "./user.ts";

// The statement log of the current replay: jobs and reads are pushed beside the statements, in arrival order.
let log: string[] = [];
const pendingRefreshes = new Set<string>();
vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  currentJobsRuntime: () => ({}),
  performAsync: vi.fn(async (jobClass: string, args: unknown[]) => {
    // RefreshAudienceMemberJob is lock: :until_executing, so the second push of the same pair never reaches Sidekiq's client
    // middleware (the recording has no second job); the real runtime dedupes through Redis, which this test has none of.
    if (jobClass === "RefreshAudienceMemberJob") {
      const key = JSON.stringify(args, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
      if (pendingRefreshes.has(key)) return null;
      pendingRefreshes.add(key);
    }
    log.push(`JOB ${jobClass}`);
    return "jid";
  }),
}));
vi.mock("../mail/active-job.ts", async (importActual) => ({
  ...(await importActual<typeof import("../mail/active-job.ts")>()),
  deliverLater: vi.fn(async (_runtime: unknown, input: { jobClass?: string }) => {
    log.push(`JOB ${input.jobClass ?? "MailDeliveryJob"}`);
    return "jid";
  }),
}));

afterEach(() => {
  log = [];
  pendingRefreshes.clear();
  setUrlRedirectTokenGenerator(null);
});

type Redis = { redis: string[]; result: unknown };
type Flipper = { flipper: string; actor: string | null; result: boolean };
type Read = Entry | Redis | Flipper;
const asRead = (entry: Entry) => entry as Read;

// The Redis commands Flipper issues itself ("hgetall <feature>") are not the app's reads: the Flipper entry stands for them.
const isFlipperInternal = (entry: Read) => "redis" in entry && entry.redis[0] === "hgetall";

// What the app read, in order: the recording's own entries after the transition began, rendered as the test logs them.
function expectedAfter(c: GoldenCase, from: number, to: number): string[] {
  const out: string[] = [];
  for (const entry of c.statements.slice(from, to).map(asRead)) {
    if ("sql" in entry) out.push(entry.sql);
    else if ("job" in entry) out.push(`JOB ${entry.job}`);
    else if ("flipper" in entry) out.push(`FLIPPER ${entry.flipper} ${entry.actor ?? "-"}`);
    else if ("redis" in entry && !isFlipperInternal(entry)) {
      const [command, ...rest] = entry.redis;
      out.push(command === "eval" ? `REDIS eval ${rest.slice(2).join(" ")}` : `REDIS ${command} ${rest.join(" ")}`);
    }
  }
  return out;
}

// Answers each read from the recording, in the order Rails made them, and logs it.
function recordedEffects(c: GoldenCase, from: number): CheckoutEffects {
  const answers = c.statements
    .slice(from)
    .map(asRead)
    .filter((entry) => ("redis" in entry && !isFlipperInternal(entry)) || "flipper" in entry);
  const take = () => answers.shift()!;
  return {
    async featureActive(name, actor) {
      log.push(`FLIPPER ${name} ${actor ?? "-"}`);
      const entry = take() as Flipper;
      expect(entry.flipper).toBe(name);
      return entry.result;
    },
    async redisGet(key) {
      log.push(`REDIS get ${key}`);
      return (take() as Redis).result as string | null;
    },
    async redisMget(keys) {
      log.push(`REDIS mget ${keys.join(" ")}`);
      return (take() as Redis).result as (string | null)[];
    },
    async clearProductFailureStreak(keys) {
      log.push(`REDIS eval ${keys.map((key) => `failed_purchases_count:${key}`).join(" ")}`);
      take();
    },
    randomDelaySeconds: () => 0,
  };
}

const startOfTransition = (c: GoldenCase) => {
  // the second "Purchase#save" whose first statement is the succeeded_at UPDATE
  const i = c.statements.findIndex(
    (entry, at) =>
      "marker" in entry &&
      entry.marker === "Purchase#save" &&
      entry.phase === "start" &&
      c.statements.slice(at, at + 3).some((next) => isSql(next) && next.sql.includes("`succeeded_at`")),
  );
  return i;
};
const endOfTransition = (c: GoldenCase) => {
  const i = c.statements.findIndex((entry) => "job" in entry && entry.job === "ActivateIntegrationsWorker");
  return i + 1;
};

type Change = {
  // The recording's transition entries with one answer changed, as MySQL would answer a different state
  entries?: (entries: Entry[]) => Entry[];
  effects?: (recorded: CheckoutEffects) => CheckoutEffects;
};

async function run(c: GoldenCase, change: Change = {}) {
  const first = firstSaveSpan(c);
  const from = startOfTransition(c);
  const to = endOfTransition(c);
  const rest: Entry[] = (change.entries ?? ((entries) => entries))(c.statements.slice(from, to));
  const sql = sqlReplay([...first.filter(isSql), ...rest.filter(isSql)]);
  const purchase = buildPurchase(c, first);
  const context = purchase.ivars.context as PurchaseContext;
  const insertOf = (table: string) =>
    c.statements.filter(isSql).find((statement) => statement.sql.startsWith(`INSERT INTO \`${table}\``));
  context.chargeReceipt = true;
  context.orderId = BigInt(parseInsert(insertOf("order_purchases")!.sql).row.order_id as number);
  const token = String(parseInsert(insertOf("url_redirects")!.sql).row.token);
  setUrlRedirectTokenGenerator(() => token);
  context.urlParameters = null;
  const recorded = recordedEffects(c, from);
  context.effects = change.effects ? change.effects(recorded) : recorded;
  const version = parseInsert(first.filter(isSql).find((s) => s.sql.startsWith("INSERT INTO `versions`"))!.sql).row;
  const outcome = await withExecutor(() =>
    withPaperTrailRequest(
      {
        controllerInfo: {
          remote_ip: version.remote_ip as string,
          request_path: version.request_path as string,
          request_uuid: version.request_uuid as string,
        },
      },
      async () => {
        await Purchases.saveBang(purchase, { now: () => NOW });
        log = sql.log;
        log.length = 0;
        return markFreePurchaseSuccessful(purchase, { now: () => NOW }).catch((error: unknown) => error);
      },
    ),
  );
  return { log, outcome, from, to };
}

describe("Purchase success (free checkout)", () => {
  for (const c of golden.cases) {
    it(`sends the statements, reads and pushes of the transition of ${c.name}`, async () => {
      const { log: sent, outcome, from, to } = await run(c);
      if (outcome instanceof Error) throw outcome;
      expect(sent).toEqual(expectedAfter(c, from, to));
    });
  }
});

describe("Purchase success handed back", () => {
  const c = golden.cases[0]!;
  const refused = async (change: Change) => {
    const { outcome } = await run(c, change);
    expect(outcome).toBeInstanceOf(NotPortedError);
  };
  const countIs = (count: number) => (entries: Entry[]) =>
    entries.map((entry) =>
      isSql(entry) && entry.sql.startsWith("SELECT COUNT(*) FROM `purchases`")
        ? { ...entry, result: { fields: ["COUNT(*)"], rows: [[count]] } }
        : entry,
    );
  const flagOn = (flagName: string) => (recorded: CheckoutEffects) => ({
    ...recorded,
    featureActive: async (name: string, actor?: string | null) =>
      name === flagName ? true : recorded.featureActive(name, actor),
  });

  it("hands back a Gumroad Day date in Redis", async () => {
    await refused({ effects: (recorded) => ({ ...recorded, redisGet: async () => "2026-11-04" }) });
  });

  it("hands back a seller whose Gumroad fee is waived", async () => {
    await refused({ effects: flagOn("waive_gumroad_fee_on_new_sales") });
  });

  it("hands back a seller on the high-volume fee", async () => {
    await refused({ effects: flagOn("high_volume_seller_fee") });
  });

  it("hands back a repeated free download from one address", async () => {
    await refused({ entries: countIs(3) });
  });

  it("allows as many free downloads from one address as the key sets", async () => {
    const { outcome } = await run(c, { entries: countIs(2) });
    expect(outcome).not.toBeInstanceOf(Error);
  });

  it("hands back an order that carries a cart", async () => {
    await refused({
      entries: (entries) =>
        entries.map((entry) =>
          isSql(entry) && entry.sql.startsWith("SELECT `orders`.*")
            ? { ...entry, result: { fields: ["id", "review_reminder_scheduled_at"], rows: [[1, null]] } }
            : isSql(entry) && entry.sql.startsWith("SELECT `carts`.* FROM `carts` WHERE `carts`.`order_id`")
              ? { ...entry, result: { fields: ["id"], rows: [[1]] } }
              : entry,
        ),
    });
  });
});
