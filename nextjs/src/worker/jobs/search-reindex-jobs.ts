// Ports of app/sidekiq/reindex_subscription_current_email_worker.rb and
// app/sidekiq/backfill_merchant_account_recommendation_eligibility_job.rb: both only read rows and
// enqueue the jobs that touch Elasticsearch.
import { Prisma } from "@prisma/client";

import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { column, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { PurchaseFlags } from "../../server/search/flags.ts";
import { RecordNotFound } from "../../server/search/indexer.ts";
import { findById } from "../../server/search/rows.ts";
import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1000;
const SUBSCRIPTION_EMAIL_FIELDS = ["subscription_current_email", "subscription_current_email_domain"];

export const reindexSubscriptionCurrentEmailWorkerWith = modelJob({ min: 1 }, async ([userId]) => {
  const user = await findById("User", "users", userId);
  if (!user) throw new RecordNotFound("User", userId);

  const subscriptionIds = Prisma.sql`SELECT ${column("subscriptions", "id")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "user_id")} = ${user.id}`;
  const where = Prisma.sql`${column("purchases", "subscription_id")} IN (${subscriptionIds}) AND (${PurchaseFlags.condition("is_original_subscription_purchase")})`;
  const id = column("purchases", "id");
  let after: unknown = null;
  for (;;) {
    const rows = await selectRows<{ id: JsonValue }>(
      Prisma.sql`SELECT ${id} FROM ${table("purchases")} WHERE ${where}${after === null ? Prisma.empty : Prisma.sql` AND ${id} > ${after}`} ORDER BY ${id} ASC LIMIT ${Prisma.raw(String(FIND_EACH_BATCH_SIZE))}`,
    );
    for (const row of rows) {
      await performAsync("ElasticsearchIndexerWorker", ["update", { record_id: row.id, class_name: "Purchase", fields: SUBSCRIPTION_EMAIL_FIELDS }]);
    }
    if (rows.length < FIND_EACH_BATCH_SIZE) return;
    after = rows.at(-1)!.id;
  }
});

export const reindexSubscriptionCurrentEmailWorker = reindexSubscriptionCurrentEmailWorkerWith();

const MERCHANT_ACCOUNT_BATCH_SIZE = 500;
const DISCONNECTED_ACCOUNTS = Prisma.raw(
  "`merchant_accounts`.`user_id` IS NOT NULL AND `merchant_accounts`.`charge_processor_id` IN ('paypal', 'stripe') AND (deleted_at IS NOT NULL OR charge_processor_deleted_at IS NOT NULL OR charge_processor_alive_at IS NULL)",
);

class JsonParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSON::ParserError";
  }
}

// `serialize :json_data, coder: JSON`: JSON.load, which reads a blank column as nil.
function loadJsonData(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new JsonParserError((error as Error).message);
  }
}

const isHash = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function rubyClassName(value: unknown): string {
  if (value === null) return "NilClass";
  if (typeof value === "string") return "String";
  if (typeof value === "boolean") return value ? "TrueClass" : "FalseClass";
  if (typeof value === "number") return Number.isInteger(value) ? "Integer" : "Float";
  return "Object";
}

// Hash#dig("meta", "stripe_connect"): nil stops the walk; an Array cannot take a String index,
// and anything else has no #dig at all.
function digStripeConnect(jsonData: Record<string, unknown>): unknown {
  const meta = jsonData.meta;
  if (meta === undefined || meta === null) return null;
  if (isHash(meta)) return meta.stripe_connect;
  if (Array.isArray(meta)) throw Object.assign(new TypeError("no implicit conversion of String into Integer"), { name: "TypeError" });
  throw Object.assign(new TypeError(`${rubyClassName(meta)} does not have #dig method`), { name: "TypeError" });
}

function connectedPayoutAccount(account: Record<string, unknown>): boolean {
  if (account.charge_processor_id === "paypal") return true;
  if (account.charge_processor_id !== "stripe") return false;
  const jsonData = loadJsonData(account.json_data);
  // `account[:json_data] || {}`: false and nil both fall back to an empty Hash.
  const data = jsonData === null || jsonData === false ? {} : jsonData;
  if (!isHash(data)) return true;
  return digStripeConnect(data) === "true";
}

export const backfillMerchantAccountRecommendationEligibilityJobWith = modelJob({ min: 0 }, async () => {
  await findInBatches<Record<string, unknown>>("merchant_accounts", DISCONNECTED_ACCOUNTS, MERCHANT_ACCOUNT_BATCH_SIZE, async (accounts) => {
    const userIds = new Map<string, unknown>();
    for (const account of accounts) {
      if (connectedPayoutAccount(account) && !userIds.has(String(account.user_id))) userIds.set(String(account.user_id), account.user_id);
    }
    for (const userId of userIds.values()) await performAsync("RefreshMerchantAccountProductsRecommendationEligibilityJob", [userId as JsonValue]);
  });
});

export const backfillMerchantAccountRecommendationEligibilityJob = backfillMerchantAccountRecommendationEligibilityJobWith();
