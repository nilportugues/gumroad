// Replays purchase-paid-success.golden.json (scripts/golden/purchase-paid-success.rb): Purchase::MarkSuccessfulService#perform for a
// purchase Stripe has charged. Node must send the statements, push the jobs and read Redis and Flipper in the order Rails did,
// given the answers MySQL, Redis and Flipper gave Rails, and hand back (before any write) the shapes it does not serve.
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";

import { flowOf, isSql, loadGolden, setupSale, type Entry, type GoldenCase } from "./__fixtures__/paid-sale-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import type { CheckoutEffects } from "./checkout-effects.ts";
import type { ChargeMerchantAccount } from "./purchase-charge-facts.ts";
import type { PurchaseContext } from "./purchase-create.ts";
import { assertPaidSuccessServable, markPaidPurchaseSuccessful } from "./purchase-success.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { setUrlRedirectTokenGenerator } from "./url-redirect.ts";
import { NotPortedError } from "./user.ts";

const golden = loadGolden("purchase-paid-success.golden.json");

// The log of the current replay: jobs and reads are pushed beside the statements, in arrival order.
let log: string[] = [];
vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  currentJobsRuntime: () => ({}),
  performAsync: vi.fn((jobClass: string) => {
    log.push(`JOB ${jobClass}`);
    return Promise.resolve("jid");
  }),
}));
vi.mock("../mail/active-job.ts", async (importActual) => ({
  ...(await importActual<typeof import("../mail/active-job.ts")>()),
  deliverLater: vi.fn((_runtime: unknown, input: { jobClass?: string }) => {
    log.push(`JOB ${input.jobClass ?? "MailDeliveryJob"}`);
    return Promise.resolve("jid");
  }),
}));

afterEach(() => {
  log = [];
  setUrlRedirectTokenGenerator(null);
});

type Redis = { redis: string[]; result: unknown };
type Flipper = { flipper: string; actor: string | null; result: boolean };
type Read = Entry | Redis | Flipper;
const asRead = (entry: Entry) => entry as Read;

// The Redis commands Flipper issues itself ("hgetall <feature>") are not the app's reads: the Flipper entry stands for them.
const isFlipperInternal = (entry: Read) => "redis" in entry && entry.redis[0] === "hgetall";

const markerAt = (c: GoldenCase, phase: string) =>
  c.statements.findIndex((entry) => "marker" in entry && entry.marker === "success" && entry.phase === phase);

// What the app did inside the span, in order, rendered the way the replay logs it.
function expectedLog(c: GoldenCase): string[] {
  const out: string[] = [];
  for (const entry of c.statements.slice(markerAt(c, "start") + 1, markerAt(c, "end")).map(asRead)) {
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
function recordedEffects(c: GoldenCase): CheckoutEffects {
  const answers = c.statements
    .slice(markerAt(c, "start") + 1, markerAt(c, "end"))
    .map(asRead)
    .filter((entry) => ("redis" in entry && !isFlipperInternal(entry)) || "flipper" in entry);
  const take = () => answers.shift()!;
  return {
    featureActive(name, actor) {
      log.push(`FLIPPER ${name} ${actor ?? "-"}`);
      const entry = take() as Flipper;
      expect(entry.flipper).toBe(name);
      return Promise.resolve(entry.result);
    },
    redisGet(key) {
      log.push(`REDIS get ${key}`);
      return Promise.resolve((take() as Redis).result as string | null);
    },
    redisMget(keys) {
      log.push(`REDIS mget ${keys.join(" ")}`);
      return Promise.resolve((take() as Redis).result as (string | null)[]);
    },
    clearProductFailureStreak(keys) {
      log.push(`REDIS eval ${keys.map((key) => `failed_purchases_count:${key}`).join(" ")}`);
      take();
      return Promise.resolve();
    },
    randomDelaySeconds: () => 0,
  };
}

// The account `prepare_merchant_account` assigned to the charged instance: no SELECT for it in the recording
function merchantAccountOf(c: GoldenCase): ChargeMerchantAccount | undefined {
  const row = c.seed.map(parseInsert).find((parsed) => parsed.table === "merchant_accounts")?.row;
  return row as unknown as ChargeMerchantAccount | undefined;
}

async function run(c: GoldenCase, change: { entries?: (entries: Entry[]) => Entry[] } = {}) {
  const { span, purchase } = setupSale(c, "success");
  const sql = sqlReplay((change.entries ?? ((entries) => entries))(span).filter(isSql));
  const context = purchase.ivars.context as PurchaseContext;
  const insertOf = (table: string) =>
    c.statements.filter(isSql).find((statement) => statement.sql.startsWith(`INSERT INTO \`${table}\``));
  const orderPurchase = c.seed.map(parseInsert).find((parsed) => parsed.table === "order_purchases");
  context.chargeReceipt = Boolean(orderPurchase);
  context.orderId = orderPurchase ? BigInt(orderPurchase.row.order_id as number) : null;
  context.urlParameters = null;
  context.effects = recordedEffects(c);
  const token = insertOf("url_redirects");
  if (token) setUrlRedirectTokenGenerator(() => String(parseInsert(token.sql).row.token));
  log = sql.log;
  const outcome = await withExecutor(() =>
    markPaidPurchaseSuccessful(
      purchase,
      { flowOfFunds: flowOf(c), merchantAccount: merchantAccountOf(c) },
      { now: () => golden.now },
    ),
  ).catch((error: unknown) => error);
  return { log, outcome, purchase };
}

// Cases Node does not run through the transition: the cart is refused by the preflight, no order by the guard.
const REFUSED = new Set(["a sale in an order that carries a cart", "a sale with no order"]);

describe("Purchase::MarkSuccessfulService for a charged purchase", () => {
  for (const c of golden.cases.filter((candidate) => !REFUSED.has(candidate.name))) {
    it(`sends the statements, reads and pushes of ${c.name}`, async () => {
      const { log: sent, outcome } = await run(c);
      if (outcome instanceof Error) throw outcome;
      expect(sent).toEqual(expectedLog(c));
      expect((c as GoldenCase & { final_state: string }).final_state).toBe("successful");
    });
  }

  it("books the seller's balance transaction before it marks the purchase successful", async () => {
    const c = golden.cases[0]!;
    const { log: sent } = await run(c);
    const state = sent.findIndex((statement) => statement.includes("`purchase_state` = 'successful'"));
    const booked = sent.findIndex((statement) => statement.startsWith("INSERT INTO `balance_transactions`"));
    expect(booked).toBeGreaterThan(-1);
    expect(booked).toBeLessThan(state);
  });

  it("sends no balance transaction for a sale held by the seller's own account", async () => {
    const c = golden.cases.find((candidate) => candidate.name.includes("Connect"))!;
    const { log: sent } = await run(c);
    expect(sent.some((statement) => statement.includes("balance_transactions"))).toBe(false);
  });

  it("hands back a purchase with no order before it sends a statement", async () => {
    const c = golden.cases.find((candidate) => candidate.name === "a sale with no order")!;
    const { outcome, log: sent } = await run(c);
    expect(outcome).toBeInstanceOf(NotPortedError);
    expect((outcome as Error).message).toContain("a purchase without a charge receipt");
    expect(sent).toEqual([]);
  });

  it("asks for the cart of the order with reads only, so the caller can hand back before the card is charged", async () => {
    const c = golden.cases.find((candidate) => candidate.name === "a sale in an order that carries a cart")!;
    const { span, purchase } = setupSale(c, "success");
    const reads = span.filter(isSql).filter((entry) => /^SELECT `(orders|carts)`\.\*/u.test(entry.sql));
    const sql = sqlReplay(reads);
    (purchase.ivars.context as PurchaseContext).chargeReceipt = true;
    const outcome = await withExecutor(() => assertPaidSuccessServable(purchase)).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(NotPortedError);
    expect((outcome as Error).message).toContain("an order with a cart");
    expect(sql.log.every((statement) => statement.startsWith("SELECT"))).toBe(true);
  });

  describe("handed back before the first write", () => {
    const c = () => golden.cases[0]!;
    const refusedWith = async (set: (purchase: Awaited<ReturnType<typeof run>>["purchase"]) => void) => {
      const { span, purchase } = setupSale(c(), "success");
      const sql = sqlReplay(span.filter(isSql));
      set(purchase);
      const context = purchase.ivars.context as PurchaseContext;
      context.chargeReceipt = true;
      const outcome = await withExecutor(() =>
        markPaidPurchaseSuccessful(purchase, { flowOfFunds: flowOf(c()) }, { now: () => golden.now }),
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(NotPortedError);
      expect(sql.log).toEqual([]);
    };

    it("hands back a sale with an affiliate", async () => {
      await refusedWith((purchase) => purchase.set("affiliate_id", 5n as never));
    });

    it("hands back a membership charge", async () => {
      await refusedWith((purchase) => purchase.set("subscription_id", 5n as never));
    });

    it("hands back a free purchase", async () => {
      await refusedWith((purchase) => purchase.set("price_cents", 0 as never));
    });
  });
});
