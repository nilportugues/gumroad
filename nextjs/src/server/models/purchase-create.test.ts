// Replays the first save of the purchase in purchase-create.golden.json (scripts/golden/purchase-create.rb): POST /orders for a
// free product, as the real app ran it. Node must send the statements Rails sent for that save, and push the jobs, in order,
// given the answers MySQL gave Rails.
import { afterEach, describe, expect, it, vi } from "vitest";

import { sqlReplay } from "../../worker/jobs/__fixtures__/sql-replay.ts";
import { PurchaseFlags } from "../search/flags.ts";

import {
  buildPurchase,
  firstSaveSpan,
  golden,
  isMarker,
  isSql,
  NOW,
  type Entry,
  type GoldenCase,
} from "./__fixtures__/purchase-golden.ts";
import { parseInsert } from "./__fixtures__/sql-insert.ts";
import { withPaperTrailRequest } from "./concerns/paper-trail.ts";
import { LinkFlags } from "./link.ts";
import { assertFreeCheckoutPurchase, Purchases, type PurchaseContext } from "./purchase-create.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { NotPortedError } from "./user.ts";

const jobs: { jobClass: string; args: unknown[]; options: unknown }[] = [];
let onJob: (jobClass: string) => void = () => {};
vi.mock("./concerns/job-runtime.ts", async (importActual) => ({
  ...(await importActual<typeof import("./concerns/job-runtime.ts")>()),
  performAsync: vi.fn(async (jobClass: string, args: unknown[], options: unknown) => {
    jobs.push({ jobClass, args, options });
    onJob(jobClass);
    return "jid";
  }),
}));

afterEach(() => {
  jobs.length = 0;
  onJob = () => {};
});

describe("Purchase create (free checkout)", () => {
  for (const c of golden.cases) {
    it(`sends the statements and pushes the jobs of ${c.name}`, async () => {
      const span = firstSaveSpan(c);
      const sql = sqlReplay(span.filter(isSql));
      onJob = (jobClass) => sql.log.push(`JOB ${jobClass}`);
      const expected = span.map((entry) => (isSql(entry) ? entry.sql : `JOB ${(entry as { job: string }).job}`));
      const purchase = buildPurchase(c, span);
      assertFreeCheckoutPurchase(purchase, purchase.ivars.context as PurchaseContext);

      const version = parseInsert(span.filter(isSql).find((s) => s.sql.startsWith("INSERT INTO `versions`"))!.sql).row;
      await withExecutor(() =>
        withPaperTrailRequest(
          {
            controllerInfo: {
              remote_ip: version.remote_ip as string,
              request_path: version.request_path as string,
              request_uuid: version.request_uuid as string,
            },
          },
          () => Purchases.saveBang(purchase, { now: () => NOW }),
        ),
      );

      expect(sql.log).toEqual(expected);
    });
  }

  // The case's span with one statement answering rows, as MySQL would for a buyer the guard stops.
  // `skipped` are statements the guards no longer send once an earlier one has added an error (`return if errors.present?`).
  const withAnswer = (match: string, fields: string[], row: unknown[], skipped: string[] = []) => {
    const c = golden.cases[0]!;
    const span = firstSaveSpan(c)
      .filter((entry) => !(isSql(entry) && skipped.some((text) => entry.sql.includes(text))))
      .map((entry) =>
        isSql(entry) && entry.sql.includes(match) ? { ...entry, result: { fields, rows: [row] } } : entry,
      ) as Entry[];
    return { c, span };
  };
  const saveWith = async (c: GoldenCase, span: Entry[]) => {
    sqlReplay(span.filter(isSql));
    const purchase = buildPurchase(c, span);
    await withExecutor(() => Purchases.saveBang(purchase, { now: () => NOW }).catch((error: unknown) => error));
    return purchase;
  };
  const blockFields = [
    "id",
    "object_type",
    "object_value",
    "blocked_at",
    "expires_at",
    "blocked_by",
    "created_at",
    "updated_at",
  ];

  it("refuses a free download from an address the product has blocked, and still inserts the purchase", async () => {
    const { c, span } = withAnswer(
      "`object_type` = 'product_ip_address'",
      blockFields,
      [1, "product_ip_address", "1:127.0.0.1", null, null, null, null, null],
      ["FROM `prices`"],
    );
    const purchase = await saveWith(c, span);
    // check_for_fraud runs on and the INSERT still happens: the message is the first guard's
    expect(purchase.errors.fullMessages()).toEqual(["The transaction could not complete."]);
    expect(purchase.persisted).toBe(true);
  });

  it("refuses an email domain that is blocked", async () => {
    const { c, span } = withAnswer("`object_type` = 'email_domain'", blockFields, [
      1,
      "email_domain",
      "example.com",
      null,
      null,
      null,
      null,
      null,
    ]);
    const purchase = await saveWith(c, span);
    expect(purchase.get("error_code")).toBe("blocked_email_domain");
    expect(purchase.errors.fullMessages()).toEqual(["The transaction could not complete."]);
  });

  it("refuses a browser that is blocked", async () => {
    const { c, span } = withAnswer("`object_value` = '00000000-0000-4000-8000-000000000006' LIMIT 1", blockFields, [
      1,
      "browser_guid",
      "g",
      null,
      null,
      null,
      null,
      null,
    ]);
    const purchase = await saveWith(c, span);
    expect(purchase.get("error_code")).toBe("blocked_browser_guid");
  });

  it("asks for a confirmation when the same email already holds the product", async () => {
    const { c, span } = withAnswer(
      "`purchases`.`ip_address` = '127.0.0.1'",
      ["id", "purchase_state", "created_at"],
      [9, "successful", { $time: "2026-11-04T12:29:00.000000Z" }],
    );
    const purchase = await saveWith(c, span);
    expect(purchase.get("error_code")).toBe("duplicate_purchase_confirmation_required");
    expect(purchase.persisted).toBe(false);
  });

  it("lets a repeat through when the earlier success is older than three minutes", async () => {
    const { c, span } = withAnswer(
      "`purchases`.`ip_address` = '127.0.0.1'",
      ["id", "purchase_state", "created_at"],
      [9, "successful", { $time: "2026-11-04T12:20:00.000000Z" }],
    );
    const purchase = await saveWith(c, span);
    expect(purchase.persisted).toBe(true);
    expect(purchase.get("error_code")).toBeNull();
  });

  it("rejects an email that is not an address, before any other statement", async () => {
    const c = golden.cases[0]!;
    const span = firstSaveSpan(c);
    const sql = sqlReplay(span.filter(isSql));
    const purchase = buildPurchase(c, span);
    purchase.set("email", "not an email");
    await withExecutor(() => Purchases.save(purchase, { now: () => NOW }));
    expect(purchase.errors.fullMessages()).toEqual(["valid email required"]);
    expect(sql.log.filter((statement) => statement.startsWith("INSERT"))).toEqual([]);
  });

  it("cuts a long referrer to the 191 characters the column holds", async () => {
    const c = golden.cases[0]!;
    const span = firstSaveSpan(c);
    sqlReplay(span.filter(isSql));
    const purchase = buildPurchase(c, span);
    purchase.set("referrer", "r".repeat(300));
    await withExecutor(() => Purchases.save(purchase, { now: () => NOW }));
    expect(purchase.get("referrer")).toHaveLength(191);
  });

  it("updates the saved purchase without the create-only checks or a second look for its review", async () => {
    const c = golden.cases[0]!;
    const first = firstSaveSpan(c);
    // The next "Purchase#save": `update(succeeded_at:)`, up to its COMMIT
    const from = c.statements.findIndex(
      (entry, i) =>
        isMarker(entry, "start") &&
        c.statements.slice(i, i + 4).some((next) => isSql(next) && next.sql.startsWith("UPDATE `purchases` SET")),
    );
    const to = c.statements.findIndex((entry, i) => i > from && isSql(entry) && entry.sql === "COMMIT");
    const second = c.statements.slice(from + 1, to + 1).filter(isSql);
    const sql = sqlReplay([...first.filter(isSql), ...second]);
    const purchase = buildPurchase(c, first);
    const version = parseInsert(first.filter(isSql).find((s) => s.sql.startsWith("INSERT INTO `versions`"))!.sql).row;
    await withExecutor(() =>
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
          sql.log.length = 0;
          purchase.set("succeeded_at", new Date("2026-11-04T12:30:45.000Z"));
          await Purchases.saveBang(purchase, { now: () => NOW });
        },
      ),
    );
    expect(sql.log).toEqual(second.map((statement) => statement.sql));
  });

  it("refuses a custom fee that is not an integer between 0 and 1000", async () => {
    const c = golden.cases[0]!;
    const span = firstSaveSpan(c);
    sqlReplay(span.filter(isSql));
    const check = async (fee: unknown) => {
      const purchase = buildPurchase(c, span);
      purchase.set("json_data", JSON.stringify({ custom_fee_per_thousand: fee }));
      await withExecutor(() => Purchases.valid(purchase));
      return purchase.errors.fullMessages();
    };
    expect(await check(1001)).toEqual(["Custom fee per thousand must be less than or equal to 1000"]);
    expect(await check(-1)).toEqual(["Custom fee per thousand must be greater than or equal to 0"]);
    expect(await check(2.5)).toEqual(["Custom fee per thousand must be an integer"]);
    expect(await check("abc")).toEqual(["Custom fee per thousand is not a number"]);
    expect(await check(100)).toEqual([]);
  });

  it("counts the sale against the product's inventory counter after the commit", async () => {
    const c = golden.cases[0]!;
    const span = firstSaveSpan(c);
    const sql = sqlReplay(span.filter(isSql));
    await withExecutor(() => Purchases.saveBang(buildPurchase(c, span), { now: () => NOW }));
    const log = sql.log;
    expect(log.indexOf("COMMIT")).toBeGreaterThan(-1);
    expect(
      log.findIndex((statement) => statement.startsWith("UPDATE `links` SET sales_count_for_inventory_cache")),
    ).toBe(log.indexOf("COMMIT") + 1);
  });

  describe("purchases handed back before any statement", () => {
    const refused = (change: (purchase: ReturnType<typeof buildPurchase>) => void) => {
      const c = golden.cases[0]!;
      const purchase = buildPurchase(c, firstSaveSpan(c));
      change(purchase);
      return () => assertFreeCheckoutPurchase(purchase, purchase.ivars.context as PurchaseContext);
    };
    const link = (purchase: ReturnType<typeof buildPurchase>) => (purchase.ivars.context as PurchaseContext).link;

    it.each([
      ["a priced purchase", (p: ReturnType<typeof buildPurchase>) => p.set("price_cents", 500)],
      ["a shipping charge", (p: ReturnType<typeof buildPurchase>) => p.set("shipping_cents", 100)],
      ["a subscription", (p: ReturnType<typeof buildPurchase>) => p.set("subscription_id", 3n)],
      ["an offer code", (p: ReturnType<typeof buildPurchase>) => p.set("offer_code_id", 3n)],
      [
        "a gift",
        (p: ReturnType<typeof buildPurchase>) =>
          p.set("flags", PurchaseFlags.set(p.get("flags"), "is_gift_sender_purchase", true)),
      ],
      [
        "a preorder",
        (p: ReturnType<typeof buildPurchase>) =>
          p.set("flags", PurchaseFlags.set(p.get("flags"), "is_preorder_authorization", true)),
      ],
      ["a quantity of two", (p: ReturnType<typeof buildPurchase>) => p.set("quantity", 2)],
      [
        "a physical product",
        (p: ReturnType<typeof buildPurchase>) =>
          void (link(p).flags = LinkFlags.set(link(p).flags, "is_physical", true)),
      ],
      [
        "a product with a purchase limit",
        (p: ReturnType<typeof buildPurchase>) => void (link(p).max_purchase_count = 5),
      ],
      ["a call", (p: ReturnType<typeof buildPurchase>) => void (link(p).native_type = "call")],
    ])("%s", (_name, change) => {
      expect(refused(change)).toThrow(NotPortedError);
    });

    it("accepts the plain free purchase", () => {
      expect(refused(() => {})).not.toThrow();
    });
  });

  it("pushes the Elasticsearch index job two seconds out and the audience refresh with the buyer's email", async () => {
    const c = golden.cases[0]!;
    const span = firstSaveSpan(c);
    sqlReplay(span.filter(isSql));
    await withExecutor(() => Purchases.saveBang(buildPurchase(c, span), { now: () => NOW }));

    expect(jobs.map((job) => job.jobClass)).toEqual(["ElasticsearchIndexerWorker", "RefreshAudienceMemberJob"]);
    expect(jobs[0]!.args).toEqual(["index", { record_id: 1n, class_name: "Purchase" }]);
    expect(jobs[0]!.options).toEqual({ delaySeconds: 2 });
    expect(jobs[1]!.args).toEqual(["buyer@example.com", 1n]);
  });
});
