// Replays the Charge::CreateService span of every case of purchase-paid-order.golden.json (scripts/golden/purchase-paid-order.rb): the
// real POST /orders, Stripe answered by WebMock. Node must send the statements, push the jobs and make the Stripe calls in the order
// Rails did, given the answers MySQL and Stripe gave Rails, and leave the purchases with the errors Rails put on them. Including the
// cases where an answer is lost: the purchase fails with stripe_unavailable although the card may have been charged.
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Link, Purchase, User } from "@prisma/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { sqlReplay, type Statement } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { PurchaseFlags } from "../search/flags.ts";
import { ChargeProcessorErrorRateLimit } from "../stripe/charge-processor-errors.ts";
import { StripeClient, type Transport } from "../stripe/client.ts";
import { STRIPE_API_VERSION, stripeConfigFromEnv } from "../stripe/config.ts";

import { parseInsert } from "./__fixtures__/sql-insert.ts";
import {
  normalizedQuery,
  recordedStripe,
  type Attempt,
  type ConfirmState,
} from "./__fixtures__/stripe-paid-order-fake.ts";
import { performChargeCreate, purchasesMetadata, type ChargeCreateInput } from "./charge-create-service.ts";
import type { CheckoutEffects } from "./checkout-effects.ts";
import { withPaperTrailRequest } from "./concerns/paper-trail.ts";
import { Purchases, withContext, type PurchaseRecord } from "./purchase-create.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { castRow } from "./sql.ts";
import { StripeChargeablePaymentMethod } from "./stripe-chargeable-payment-method.ts";
import { NotPortedError } from "./user.ts";

type Entry =
  | Statement
  | { marker: string; phase: string }
  | { job: string }
  | { flipper: string; actor: string | null; result: boolean }
  | { redis: string[] }
  | { http: Attempt };
type Table = { fields: string[]; rows: unknown[][] };
type Case = { name: string; seed: string[]; statements: Entry[]; rows: Record<string, Table> };

const FIXTURES = path.join(import.meta.dirname, "__fixtures__");
const golden = parseRubyJson(
  readFileSync(path.join(FIXTURES, "purchase-paid-order.golden.json"), "utf8"),
) as unknown as {
  now: string;
  cases: Case[];
};
const NOW = new Date(golden.now);
const paymentMethod = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "../../../scripts/golden/support/stripe_paid_order/payment_method_get.json"),
    "utf8",
  ),
) as Record<string, unknown>;

let log: string[] = [];
vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  currentJobsRuntime: () => ({}),
  performAsync: vi.fn((jobClass: string) => {
    log.push(`JOB ${jobClass}`);
    return Promise.resolve("jid");
  }),
}));
beforeAll(() => {
  // .env.test of the recording
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "123456789";
});
afterEach(() => {
  log = [];
});

const isSql = (entry: Entry): entry is Statement => "sql" in entry;
const isHttp = (entry: Entry): entry is { http: Attempt } => "http" in entry;
const isMarker = (entry: Entry, phase: string): boolean =>
  "marker" in entry && entry.marker === "Charge::CreateService" && entry.phase === phase;

const dateColumns = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/u;
const typed = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && dateColumns.test(v) ? `${v.replace(" ", "T")}Z` : v,
    ]),
  );

function spanOf(c: Case): Entry[] {
  const start = c.statements.findIndex((entry) => isMarker(entry, "start"));
  const end = c.statements.findIndex((entry, i) => i > start && isMarker(entry, "end"));
  return c.statements.slice(start + 1, end);
}

// `SET `purchases`.`a` = 1, `purchases`.`b` = 'x'` read back as the attribute changes Order::ChargeService had made in memory
function assignments(sql: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = /`purchases`\.`(\w+)` = ('(?:[^'\\]|\\.)*'|[^,]+?)(?=, `purchases`\.`|\s+WHERE)/gu;
  for (const [, name, raw] of sql.matchAll(set)) {
    const text = raw!.trim();
    out[name!] =
      text === "NULL"
        ? null
        : text === "TRUE"
          ? true
          : text === "FALSE"
            ? false
            : text.startsWith("'")
              ? text.slice(1, -1)
              : Number(text);
  }
  return out;
}

// The purchases as Rails held them when the span started: the row its INSERT wrote, and what the span then saved.
function purchasesOf(c: Case, span: Entry[]): PurchaseRecord[] {
  const rows = c.seed.map(parseInsert);
  const row = (table: string) => typed(rows.find((parsed) => parsed.table === table)!.row);
  const link = castRow<Link>("Link", row("links"));
  const seller = castRow<User>("User", row("users"));
  const inserts = c.statements.filter(isSql).filter((s) => s.sql.startsWith("INSERT INTO `purchases`"));
  return inserts.map((insert) => {
    const id = insert.result!.last_id!;
    const record = Purchases.load(castRow<Purchase>("Purchase", { id, ...typed(parseInsert(insert.sql).row) }));
    // Created earlier in the request, and updated since: its attributes are in column order and its review lookup is memoised
    record.changesApplied();
    const spanStart = c.statements.findIndex((entry) => isMarker(entry, "start"));
    for (const earlier of c.statements.slice(0, spanStart).filter(isSql)) {
      if (earlier.sql.startsWith("UPDATE `purchases`") && earlier.sql.endsWith(`WHERE \`purchases\`.\`id\` = ${id}`))
        for (const [name, value] of Object.entries(assignments(earlier.sql))) record.set(name as never, value as never);
    }
    record.changesApplied();
    record.ivars.productReviewLoaded = true;
    const update = span
      .filter(isSql)
      .find((s) => s.sql.startsWith("UPDATE `purchases`") && s.sql.endsWith(`WHERE \`purchases\`.\`id\` = ${id}`));
    if (update)
      for (const [name, value] of Object.entries(assignments(update.sql))) record.set(name as never, value as never);
    return withContext(record, { link, seller, buyerByEmail: null });
  });
}

async function chargeableOf(): Promise<StripeChargeablePaymentMethod> {
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_replay", apiVersion: STRIPE_API_VERSION },
    transport: () => Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(paymentMethod) }),
  });
  return StripeChargeablePaymentMethod.prepare(
    { paymentMethodId: paymentMethod.id as string, isStripeConnect: false },
    { client },
  );
}

const fakeOptions = (name: string): { confirm?: ConfirmState; decline?: Record<string, unknown> } => {
  if (name.includes("requires_action")) return { confirm: "requires_action" };
  if (name.includes("processing")) return { confirm: "processing" };
  if (name.includes("incorrect zip"))
    return { decline: { code: "incorrect_zip", decline_code: null, message: "Your card's zip code is incorrect." } };
  if (name.includes("fraudulent"))
    return { decline: { code: "card_declined", decline_code: "fraudulent", message: "Your card was declined." } };
  if (name.includes("insufficient funds"))
    return {
      decline: {
        code: "card_declined",
        decline_code: "insufficient_funds",
        message: "Your card has insufficient funds.",
      },
    };
  return {};
};

async function run(
  c: Case,
  change: { flipper?: boolean; input?: Partial<ChargeCreateInput>; transport?: Transport } = {},
) {
  const span = spanOf(c);
  const sql = sqlReplay(span.filter(isSql));
  const attempts = span.filter(isHttp).map((entry) => entry.http);
  const stripe = recordedStripe(attempts, fakeOptions(c.name));
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_replay", apiVersion: STRIPE_API_VERSION },
    sleep: () => Promise.resolve(),
    transport: (request) => {
      const url = new URL(request.url);
      log.push(`HTTP ${request.method} ${url.pathname}${url.search === "" ? "" : `?${normalizedQuery(url.search)}`}`);
      return (change.transport ?? stripe.transport)(request);
    },
  });
  const flipper = span.find((entry): entry is Extract<Entry, { flipper: string }> => "flipper" in entry)!;
  const effects: CheckoutEffects = {
    featureActive(name, actor) {
      log.push(`FLIPPER ${name} ${actor ?? "-"}`);
      expect(name).toBe(flipper.flipper);
      return Promise.resolve(change.flipper ?? flipper.result);
    },
    redisGet: () => Promise.reject(new Error("no Redis read in this span")),
    redisMget: () => Promise.reject(new Error("no Redis read in this span")),
    clearProductFailureStreak: () => Promise.reject(new Error("no Redis write in this span")),
    randomDelaySeconds: () => 0,
  };
  log = sql.log;
  const purchases = purchasesOf(c, span);
  const input: ChargeCreateInput = {
    order: { id: 1n },
    seller: { id: 1n },
    merchantAccount: { id: 1n, charge_processor_id: "stripe", user_id: null },
    chargeable: await chargeableOf(),
    purchases,
    amountCents: 0,
    gumroadAmountCents: 0,
    setupFutureCharges: false,
    offSession: false,
    statementDescription: null,
    mandateOptions: null,
    params: { buyer_currency_quote: "" },
    ...change.input,
  };
  const chargeUpdate = span.filter(isSql).find((s) => s.sql.startsWith("UPDATE `charges`"))!.sql;
  input.amountCents = Number(/`amount_cents` = (\d+)/u.exec(chargeUpdate)![1]);
  input.gumroadAmountCents = Number(/`gumroad_amount_cents` = (\d+)/u.exec(chargeUpdate)![1]);
  input.statementDescription = statementOf(c);
  // The request the version rows name (ApplicationController#info_for_paper_trail)
  const version = span.filter(isSql).find((s) => s.sql.startsWith("INSERT INTO `versions`"));
  const { remote_ip, request_path, request_uuid } = version
    ? parseInsert(version.sql).row
    : ({} as Record<string, unknown>);
  const controllerInfo = { remote_ip, request_path, request_uuid } as Record<string, string | null>;
  const outcome = await withPaperTrailRequest({ controllerInfo }, () =>
    withExecutor(() => performChargeCreate(input, { now: () => NOW, client, effects })),
  ).catch((error: unknown) => error);
  return { log, outcome, purchases, span };
}

// The suffix Order::ChargeService passes, read back from the PaymentIntent body (the descriptor is the first seven characters of the
// seller's name and the purchase's last digits), so the replay does not have to port that step.
const statementOf = (c: Case) => {
  const body =
    spanOf(c)
      .filter(isHttp)
      .find((e) => e.http.path === "/v1/payment_intents")?.http.body ?? "";
  const match = /statement_descriptor_suffix=([^&]*)/u.exec(body);
  return match ? decodeURIComponent(match[1]!.replaceAll("+", " ")) : null;
};

// What Rails logged in the span, in the order Node sends it: the Flipper read first, since Node refuses before it writes.
function expectedLog(span: Entry[]): string[] {
  const out: string[] = [];
  const flipper = span.find((entry): entry is Extract<Entry, { flipper: string }> => "flipper" in entry)!;
  out.push(`FLIPPER ${flipper.flipper} ${flipper.actor ?? "-"}`);
  for (const entry of span) {
    if (isSql(entry)) out.push(entry.sql);
    else if ("job" in entry) out.push(`JOB ${entry.job}`);
    else if (isHttp(entry))
      out.push(
        `HTTP ${entry.http.method} ${entry.http.path}${entry.http.query ? `?${normalizedQuery(entry.http.query)}` : ""}`,
      );
  }
  return out;
}

const table = (c: Case, name: string) => c.rows[name];
const column = (c: Case, tableName: string, field: string) => {
  const t = table(c, tableName);
  return t ? t.rows.map((row) => row[t.fields.indexOf(field)]) : [];
};

const SERVED = golden.cases.filter((c) => c.name !== "");

describe("Charge::CreateService", () => {
  for (const c of SERVED) {
    it(`sends the statements, Stripe calls and pushes of ${c.name}`, async () => {
      const { log: sent, outcome, span } = await run(c);
      if (outcome instanceof Error) throw outcome;
      const expected = expectedLog(span);
      const at = expected.findIndex((line, i) => line !== sent[i]);
      if (at >= 0) {
        const a = expected[at]!;
        const b = sent[at] ?? "";
        const k = [...a].findIndex((ch, i) => ch !== b[i]);
        throw new Error(
          `line ${at}: expected ...${a.slice(Math.max(0, k - 60), k + 120)}\n received ...${b.slice(Math.max(0, k - 60), k + 120)}`,
        );
      }
      expect(sent).toEqual(expected);
    });
  }

  it("leaves the intent on the charge and the fee of a succeeded charge", async () => {
    const c = golden.cases.find((candidate) => candidate.name === "a $5 sale")!;
    const { outcome } = await run(c);
    const result = outcome as Awaited<ReturnType<typeof performChargeCreate>>;
    expect(result.chargeIntent?.outcome).toBe("succeeded");
    expect(result.charge.get("stripe_payment_intent_id")).toBe(column(c, "charges", "stripe_payment_intent_id")[0]);
    expect(result.charge.get("processor_transaction_id")).toBe(column(c, "charges", "processor_transaction_id")[0]);
    expect(Number(result.charge.get("processor_fee_cents"))).toBe(column(c, "charges", "processor_fee_cents")[0]);
  });

  describe("a card that is declined", () => {
    for (const name of [
      "a declined card",
      "a declined card, incorrect zip",
      "a declined card, fraudulent",
      "a declined card, insufficient funds",
    ]) {
      it(`puts the card error on the purchase without an intent (${name})`, async () => {
        const c = golden.cases.find((candidate) => candidate.name === name)!;
        const { outcome, purchases } = await run(c);
        const result = outcome as Awaited<ReturnType<typeof performChargeCreate>>;
        expect(result.chargeIntent).toBeNull();
        expect(result.processorOutcomeUnknown).toBe(false);
        expect(purchases[0]!.get("stripe_error_code")).toBe(column(c, "purchases", "stripe_error_code")[0]);
        expect(purchases[0]!.get("stripe_transaction_id")).toBe(column(c, "purchases", "stripe_transaction_id")[0]);
        expect(purchases[0]!.errors.on("base")).toHaveLength(1);
        // charge_purchases.flags bit 11 of the purchase row Rails saved afterwards
        expect(PurchaseFlags.isSet(purchases[0]!.get("flags"), "was_zipcode_check_performed")).toBe(
          name.includes("incorrect zip"),
        );
      });
    }
  });

  describe("an answer from Stripe that is lost", () => {
    it("fails the purchase with stripe_unavailable and no intent when every PaymentIntent create loses its answer", async () => {
      const c = golden.cases.find((candidate) => candidate.name === "the PaymentIntent create loses every answer")!;
      const { outcome, purchases } = await run(c);
      const result = outcome as Awaited<ReturnType<typeof performChargeCreate>>;
      expect(result.chargeIntent).toBeNull();
      expect(result.processorOutcomeUnknown).toBe(true);
      expect(result.lostIntentId).toBeNull();
      expect(purchases[0]!.get("error_code")).toBe("stripe_unavailable");
      expect(purchases[0]!.errors.on("base")).toEqual([
        "There is a temporary problem, please try again (your card was not charged).",
      ]);
    });

    it("fails the purchase with stripe_unavailable when every confirm loses its answer, and stores no intent although it exists", async () => {
      const c = golden.cases.find((candidate) => candidate.name === "the confirm loses every answer")!;
      const { outcome, purchases } = await run(c);
      const result = outcome as Awaited<ReturnType<typeof performChargeCreate>>;
      expect(result.chargeIntent).toBeNull();
      expect(result.processorOutcomeUnknown).toBe(true);
      expect(purchases[0]!.get("error_code")).toBe("stripe_unavailable");
      // The intent was created before the confirm failed; Rails drops its id, and so does the charge here.
      expect(result.lostIntentId).toBe("pi_golden_1");
      expect(result.charge.get("stripe_payment_intent_id")).toBeNull();
    });
  });

  describe("an intent that is not settled", () => {
    it("stores the intent of a requires_action charge and none of its fee", async () => {
      const c = golden.cases.find((candidate) => candidate.name === "a requires_action intent")!;
      const { outcome } = await run(c);
      const result = outcome as Awaited<ReturnType<typeof performChargeCreate>>;
      expect(result.chargeIntent?.outcome).toBe("requires_action");
      expect(result.charge.get("stripe_payment_intent_id")).toBe("pi_golden_1");
      expect(result.charge.get("processor_transaction_id")).toBeNull();
    });
  });

  describe("what it refuses before it writes or calls Stripe", () => {
    const sale = () => golden.cases.find((candidate) => candidate.name === "a $5 sale")!;

    it("refuses a seller on buyer-currency charging after reading the flag and nothing else", async () => {
      const { outcome, log: sent } = await run(sale(), { flipper: true });
      expect(outcome).toBeInstanceOf(NotPortedError);
      expect(sent).toEqual(["FLIPPER buyer_currency_charging User;1"]);
    });

    it.each([
      ["a buyer-currency quote token", { params: { buyer_currency_quote: "token" } }],
      ["a resumed setup", { params: { setup_confirmed_resume: true } }],
      ["an off-session charge", { offSession: true }],
      ["a card that is saved for later", { setupFutureCharges: true }],
      ["mandate options", { mandateOptions: { payment_method_options: { card: {} } } }],
      ["a seller's own merchant account", { merchantAccount: { id: 2n, charge_processor_id: "stripe", user_id: 5n } }],
      ["PayPal", { merchantAccount: { id: 2n, charge_processor_id: "paypal", user_id: null } }],
    ] as [string, Partial<ChargeCreateInput>][])("refuses %s before any statement or call", async (_name, input) => {
      const { outcome, log: sent } = await run(sale(), { input });
      expect(outcome).toBeInstanceOf(NotPortedError);
      expect(sent.filter((line) => !line.startsWith("FLIPPER"))).toEqual([]);
    });

    it("refuses a purchase with a stored card before any statement", async () => {
      const c = sale();
      const purchases = purchasesOf(c, spanOf(c));
      purchases[0]!.set("credit_card_id", 7n as never);
      const { outcome, log: sent } = await run(c, { input: { purchases } });
      expect(outcome).toBeInstanceOf(NotPortedError);
      expect(sent.filter((line) => !line.startsWith("FLIPPER"))).toEqual([]);
    });
  });
});

// Read off charge_create_service.rb, not recorded: the golden has no 429, no malformed request and no leftover presentment row.
describe("Stripe errors the golden does not record", () => {
  const decline = () => golden.cases.find((candidate) => candidate.name === "a declined card")!;
  const answering =
    (status: number, error: Record<string, unknown>): Transport =>
    (request) =>
      Promise.resolve({
        status,
        headers: {},
        body: JSON.stringify(new URL(request.url).pathname === "/v1/payment_intents" ? { error } : {}),
      });

  it("marks the purchase stripe_unavailable and raises when Stripe rate limits the intent create", async () => {
    const purchases = purchasesOf(decline(), spanOf(decline()));
    const { outcome, log: sent } = await run(decline(), {
      input: { purchases },
      transport: answering(429, { type: "rate_limit_error", message: "Too many requests" }),
    });
    expect(outcome).toBeInstanceOf(ChargeProcessorErrorRateLimit);
    expect(purchases[0]!.get("error_code")).toBe("stripe_unavailable");
    expect(sent.filter((line) => line.startsWith("HTTP"))).toEqual(["HTTP POST /v1/payment_intents"]);
    expect(sent.some((line) => line.includes("presentments"))).toBe(false);
  });

  it("names a malformed request processor_invalid_request and keeps Stripe's code on the purchase", async () => {
    const purchases = purchasesOf(decline(), spanOf(decline()));
    const { outcome } = await run(decline(), {
      input: { purchases },
      transport: answering(400, {
        type: "invalid_request_error",
        code: "parameter_invalid_integer",
        message: "Invalid integer",
      }),
    });
    expect(outcome).not.toBeInstanceOf(Error);
    expect(purchases[0]!.get("error_code")).toBe("processor_invalid_request");
    expect(purchases[0]!.get("stripe_error_code")).toBe("parameter_invalid_integer");
    expect(purchases[0]!.errors.on("base")).toEqual([
      "There is a temporary problem, please try again (your card was not charged).",
    ]);
  });
});

describe("purchasesMetadata", () => {
  it("lists the purchases under purchases{0} separated by commas", () => {
    expect(purchasesMetadata(["a", "b"])).toEqual({ "purchases{0}": "a,b" });
  });

  it("starts a new key when a value would pass 500 characters", () => {
    const long = "x".repeat(300);
    expect(purchasesMetadata([long, long])).toEqual({ "purchases{0}": long, "purchases{1}": long });
  });
});
