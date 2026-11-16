// Replays POST /orders for a free product in purchase-create.golden.json (scripts/golden/purchase-create.rb) from the
// controller's fetch of the product to the receipt job: Node must send every statement, read Redis and Flipper, and push every
// job in the order Rails did, given the answers MySQL, Redis and Flipper gave Rails.
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { golden, isSql, NOW, type Entry, type GoldenCase } from "../models/__fixtures__/purchase-golden.ts";
import { parseInsert } from "../models/__fixtures__/sql-insert.ts";
import type { CheckoutEffects } from "../models/checkout-effects.ts";
import { withPaperTrailRequest } from "../models/concerns/paper-trail.ts";
import { withExecutor } from "../models/runtime/query-cache.ts";
import { setUrlRedirectTokenGenerator } from "../models/url-redirect.ts";
import { NotPortedError } from "../models/user.ts";

import { createFreeOrder, type FreeOrderRequest } from "./free-order-create.ts";

let log: string[] = [];
const pendingRefreshes = new Set<string>();
vi.mock("../models/concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("../models/concerns/job-runtime.ts")>()),
  currentJobsRuntime: () => ({}),
  performAsync: vi.fn((jobClass: string, args: unknown[]) => {
    // lock: :until_executing, so the second push of the same pair never reaches Sidekiq's client middleware
    if (jobClass === "RefreshAudienceMemberJob") {
      const key = JSON.stringify(args, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
      if (pendingRefreshes.has(key)) return Promise.resolve(null);
      pendingRefreshes.add(key);
    }
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
  pendingRefreshes.clear();
  setUrlRedirectTokenGenerator(null);
});

type Redis = { redis: string[]; result: unknown };
type Flipper = { flipper: string; actor: string | null; result: boolean };
type Read = Entry | Redis | Flipper;
const asRead = (entry: Entry) => entry as Read;

// Flipper's own hgetall, the checkout's recaptcha flag (read by controller code this service does not run) and the
// subdomain redirect cache read of the request.
const isNoise = (entry: Read) =>
  ("redis" in entry && (entry.redis[0] === "hgetall" || entry.redis[1]?.startsWith("subdomain_redirect"))) ||
  ("flipper" in entry && entry.flipper === "recaptcha_score_checkout") ||
  "marker" in entry;

const FIRST_STATEMENT = (c: GoldenCase) => c.statements.findIndex(isSql);

function expectedLog(c: GoldenCase): string[] {
  const out: string[] = [];
  for (const entry of c.statements.slice(FIRST_STATEMENT(c)).map(asRead)) {
    if (isNoise(entry)) continue;
    if ("sql" in entry) out.push(entry.sql);
    else if ("job" in entry) out.push(`JOB ${entry.job}`);
    else if ("flipper" in entry) out.push(`FLIPPER ${entry.flipper} ${entry.actor ?? "-"}`);
    else if ("redis" in entry) {
      const [command, ...rest] = entry.redis;
      out.push(command === "eval" ? `REDIS eval ${rest.slice(2).join(" ")}` : `REDIS ${command} ${rest.join(" ")}`);
    }
  }
  return out;
}

function recordedEffects(c: GoldenCase): CheckoutEffects {
  const answers = c.statements
    .slice(FIRST_STATEMENT(c))
    .map(asRead)
    .filter((entry) => !isNoise(entry) && ("flipper" in entry || "redis" in entry));
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

const insertOf = (c: GoldenCase, prefix: string) =>
  c.statements.filter(isSql).find((statement) => statement.sql.startsWith(prefix))!;

function requestOf(c: GoldenCase): FreeOrderRequest {
  const body = c.request as { line_items: Record<string, unknown>[] } & Record<string, unknown>;
  const { line_items: lines, ...params } = body;
  const purchase = parseInsert(insertOf(c, "INSERT INTO `purchases`").sql).row;
  return {
    params,
    line: lines[0]!,
    ip: "127.0.0.1",
    browserGuid: purchase.browser_guid as string,
    sessionId: null,
    isMobile: false,
    buyer: null,
    userAgent: null,
    acceptLanguage: null,
    referer: "http://app.test.gumroad.com/checkout",
    pathInfo: "/orders",
    now: () => NOW,
  };
}

async function run(c: GoldenCase, change: (entries: Entry[]) => Entry[] = (entries) => entries) {
  const entries = change(c.statements.slice(FIRST_STATEMENT(c)));
  const sql = sqlReplay(entries.filter(isSql));
  log = sql.log;
  const request = { ...requestOf(c), effects: recordedEffects(c) };
  const token = String(parseInsert(insertOf(c, "INSERT INTO `url_redirects`").sql).row.token);
  setUrlRedirectTokenGenerator(() => token);
  const version = parseInsert(insertOf(c, "INSERT INTO `versions`").sql).row;
  const outcome = await withExecutor(() =>
    withPaperTrailRequest(
      {
        controllerInfo: {
          remote_ip: version.remote_ip as string,
          request_path: version.request_path as string,
          request_uuid: version.request_uuid as string,
        },
      },
      () => createFreeOrder(request).catch((error: unknown) => error),
    ),
  );
  return { log: sql.log, outcome };
}

describe("Free order create", () => {
  for (const c of golden.cases) {
    it(`sends the statements, reads and pushes of ${c.name}`, async () => {
      const { log: sent, outcome } = await run(c);
      if (outcome instanceof Error) throw outcome;
      expect(sent).toEqual(expectedLog(c));
    });
  }

  describe("handed back before the first write", () => {
    const c = golden.cases[0]!;
    const answer = (prefix: string, fields: string[], rows: unknown[][]) => (entries: Entry[]) =>
      entries.map((entry) =>
        isSql(entry) && entry.sql.startsWith(prefix) ? { ...entry, result: { fields, rows } } : entry,
      ) as Entry[];
    const writes = (sent: string[]) => sent.filter((sql) => /^(INSERT|UPDATE|DELETE)/u.test(sql));

    it("a collaborator on the product", async () => {
      const { log: sent, outcome } = await run(c, answer("SELECT `affiliates`.`id`", ["id"], [[1]]));
      expect(outcome).toBeInstanceOf(NotPortedError);
      expect(writes(sent)).toEqual([]);
    });

    it("a custom field on the product", async () => {
      const { log: sent, outcome } = await run(
        c,
        answer("SELECT `custom_fields`.* FROM `custom_fields` INNER JOIN", ["id"], [[1]]),
      );
      expect(outcome).toBeInstanceOf(NotPortedError);
      expect(writes(sent)).toEqual([]);
    });

    it("a bundle", async () => {
      const { log: sent, outcome } = await run(c, answer("SELECT `bundle_products`.*", ["id"], [[1]]));
      expect(outcome).toBeInstanceOf(NotPortedError);
      expect(writes(sent)).toEqual([]);
    });
  });
});
