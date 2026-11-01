// Read side of app/services/email_engagement_dynamo_store.rb: the SUMMARY item that holds a post's
// open and click counters, and the per-URL click totals. Writes stay in Ruby.
//
// Speaks DynamoDB's JSON protocol directly (SigV4, access key from the environment, as storage.ts
// configures S3): the AWS SDK for DynamoDB is not a dependency. Credentials from an instance role are
// not read; without an access key and secret the store throws NotPortedError.
import { createHash, createHmac } from "node:crypto";

import { getConfig } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { storageConfig } from "../infra/storage.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

export const TABLE_BASE_NAME = "email_engagement";
export const SUMMARY_SORT_KEY = "SUMMARY";
const BATCH_GET_LIMIT = 100;
const BATCH_GET_MAX_ATTEMPTS = 5;
const BATCH_GET_BACKOFF_SECONDS = 0.1;

export type EngagementSummary = { open_count: number; click_count: number; click_pair_count: number };

type AttributeValue = { S?: string; N?: string } & Record<string, unknown>;
type Item = Record<string, AttributeValue>;

// EmailEngagementDynamoStore.table_prefix
function tablePrefix(): string {
  const prefix = process.env.DYNAMODB_TABLE_PREFIX?.trim();
  if (prefix) return prefix;
  const env = railsEnv();
  return env === "production" || env === "staging" ? `${env}-` : "";
}

export const tableName = () => `${tablePrefix()}${TABLE_BASE_NAME}`;

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

async function call(operation: string, payload: unknown): Promise<Record<string, unknown>> {
  const storage = storageConfig();
  if (!storage.accessKeyId || !storage.secretAccessKey) throw new NotPortedError("DynamoDB access without AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (instance role credentials)");
  const endpoint = new URL(getConfig("DYNAMODB_ENDPOINT", `https://dynamodb.${storage.region}.amazonaws.com`));
  const body = JSON.stringify(payload);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const date = amzDate.slice(0, 8);
  const target = `DynamoDB_20120810.${operation}`;
  const headers = { "content-type": "application/x-amz-json-1.0", host: endpoint.host, "x-amz-date": amzDate, "x-amz-target": target };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = ["POST", "/", "", ...Object.keys(headers).sort().map((name) => `${name}:${headers[name as keyof typeof headers]}`), "", signedHeaders, sha256(body)].join("\n");
  const scope = `${date}/${storage.region}/dynamodb/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${storage.secretAccessKey}`, date), storage.region), "dynamodb"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": headers["content-type"],
      "x-amz-date": amzDate,
      "x-amz-target": target,
      authorization: `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`DynamoDB ${operation} failed: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const toI = (value: AttributeValue | undefined): number => (value?.N === undefined ? 0 : Math.trunc(Number(value.N)));

// summary_from_item(item)
function summaryFromItem(item: Item | undefined): EngagementSummary {
  return { open_count: toI(item?.open_count), click_count: toI(item?.click_count), click_pair_count: toI(item?.click_pair_count) };
}

const itemKey = (installmentId: number | bigint, sortKey: string) => ({ pk: { S: String(installmentId) }, sk: { S: sortKey } });

// EmailEngagementDynamoStore.summary(installment_id)
export async function summary(installmentId: number | bigint): Promise<EngagementSummary> {
  const response = await call("GetItem", { TableName: tableName(), Key: itemKey(installmentId, SUMMARY_SORT_KEY) });
  return summaryFromItem(response.Item as Item | undefined);
}

// EmailEngagementDynamoStore.summaries(installment_ids): one BatchGetItem per 100 ids.
export async function summaries(installmentIds: (number | bigint)[]): Promise<Map<number, EngagementSummary>> {
  const ids = [...new Set(installmentIds.map(Number))];
  const counts = new Map<number, EngagementSummary>();
  if (ids.length === 0) return counts;
  const table = tableName();
  for (let start = 0; start < ids.length; start += BATCH_GET_LIMIT) {
    let requestItems: Record<string, { Keys: unknown[] }> = { [table]: { Keys: ids.slice(start, start + BATCH_GET_LIMIT).map((id) => itemKey(id, SUMMARY_SORT_KEY)) } };
    for (let attempt = 0; attempt < BATCH_GET_MAX_ATTEMPTS; attempt += 1) {
      const response = await call("BatchGetItem", { RequestItems: requestItems });
      for (const item of ((response.Responses as Record<string, Item[]> | undefined)?.[table] ?? [])) counts.set(Number(item.pk?.S), summaryFromItem(item));
      requestItems = (response.UnprocessedKeys as typeof requestItems | undefined) ?? {};
      if (Object.keys(requestItems).length === 0) break;
      if (attempt === BATCH_GET_MAX_ATTEMPTS - 1) throw new Error(`Unprocessed keys remain after ${BATCH_GET_MAX_ATTEMPTS} BatchGetItem attempts`);
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * BATCH_GET_BACKOFF_SECONDS * 1000));
    }
  }
  return new Map(ids.map((id) => [id, counts.get(id) ?? summaryFromItem(undefined)]));
}
