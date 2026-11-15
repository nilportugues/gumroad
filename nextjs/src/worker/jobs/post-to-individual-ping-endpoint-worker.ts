// Port of app/sidekiq/post_to_individual_ping_endpoint_worker.rb for the deliveries SsrfFilter refuses from the URL alone, before any
// DNS lookup or connection: a scheme other than http and https, and a dotted-quad IPv4 host in one of its blocked ranges. Those
// record a PingDelivery with the error class (retry_count + 1 as the attempt) and send nothing. Every other URL (a hostname, an
// address that is public, credentials, a query, an odd form) ends in the POST, which Node never makes, so the whole job goes back to
// Rails before any statement; so do arguments whose Ruby coercions are not reproduced here.
// Golden: __fixtures__/post-to-individual-ping-endpoint-worker.golden.json (scripts/golden/post-to-individual-ping-endpoint-worker.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { findOneBy } from "../../server/models/row-reads.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SETTINGS = "ping_signing_settings";
const DELIVERIES = "ping_deliveries";
const SALE_RESOURCE_NAME = "sale";
const COLUMN_LIMIT = 255;
const OCTET_LIMIT = 255;
const MAX_PORT_DIGITS = 5;
// Registered `URI` schemes with their own parser, whose rules for the rest of the URL are not reproduced.
const OWN_PARSER_SCHEMES = new Set(["file", "ldap", "ldaps", "mailto", "ws", "wss"]);
const URL_PATTERN = new RegExp(
  `^([a-z][a-z0-9+.-]*)://([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,${MAX_PORT_DIGITS}}))?(/[A-Za-z0-9._~/-]*)?$`,
  "u",
);
const IPV4_PATTERN = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/u;

// SsrfFilter::IPV4_BLACKLIST: [address, prefix length].
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

const toInt = (octets: readonly number[]) => octets.reduce((n, o) => n * 256 + o, 0);

function blockedIpv4(octets: readonly number[]): boolean {
  const address = toInt(octets);
  return BLOCKED_IPV4.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = toInt(base.split(".").map(Number));
    return address >= start && address < start + size;
  });
}

// The error class Ruby records for a URL refused without a lookup, or null when the POST (or anything unproven) is next.
function verdictFor(url: string): string | null {
  const match = URL_PATTERN.exec(url);
  if (match === null) return null;
  const scheme = match[1]!;
  const host = match[2]!;
  if (scheme !== "http" && scheme !== "https") return OWN_PARSER_SCHEMES.has(scheme) ? null : "SsrfFilter::InvalidUriScheme";
  const ip = IPV4_PATTERN.exec(host);
  if (ip === null) return null;
  const octets = ip.slice(1).map(Number);
  if (octets.some((o) => o > OCTET_LIMIT)) return null;
  return blockedIpv4(octets) ? "SsrfFilter::PrivateIPAddress" : null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown) => value === null || value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

export const postToIndividualPingEndpointWorkerWith = modelJob({ min: 2, max: 5 }, async (args, deps) => {
  const [postUrl, params, , userId = null, ping = null] = args;
  if (typeof postUrl !== "string" || postUrl.length > COLUMN_LIMIT) throw new HandBackToRuby("a URL Node does not judge");
  if (!isPlainObject(params)) throw new HandBackToRuby("params that are not a Hash");
  const retryCount = params["retry_count"] ?? 0;
  if (typeof retryCount !== "number" || !Number.isSafeInteger(retryCount) || retryCount < 0)
    throw new HandBackToRuby("a retry count that is not a non-negative Integer");
  if (userId !== null && (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId < 0))
    throw new HandBackToRuby("a user id that is not an Integer");
  if (isPlainObject(ping)) {
    const name = ping["resource_name"];
    if (!isId(ping["purchase_id"]) || !isId(ping["subscription_id"])) throw new HandBackToRuby("a ping id that is not an Integer");
    if (name != null && (typeof name !== "string" || name.length > COLUMN_LIMIT || /[^\x20-\x7e]/u.test(name)))
      throw new HandBackToRuby("a resource name Node does not reproduce");
  }
  const errorClass = verdictFor(postUrl);
  if (errorClass === null) throw new HandBackToRuby("the POST, or a URL Node does not judge");

  if (userId === null) return;
  // The primary, then the signing secret the headers would carry: neither changes a refusal, but Ruby reads both.
  const user = await connectedTo("writing", () => findOneBy("User", "id", BigInt(userId), true));
  if (user === null) return;
  await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${SETTINGS}\`.*`)} FROM ${table(SETTINGS)} WHERE ${column(SETTINGS, "user_id")} = ${userId} LIMIT 1`,
  );
  if (!isPlainObject(ping)) return;

  const name = ping["resource_name"];
  const resourceName = typeof name === "string" && name.trim() !== "" ? name : SALE_RESOURCE_NAME;
  const columns = ["attempt", "created_at", "error_class", "post_url", "purchase_id", "resource_name", "response_code", "subscription_id", "succeeded", "user_id"];
  await transaction(async () => {
    await execute(
      Prisma.sql`INSERT INTO ${table(DELIVERIES)} (${Prisma.raw(columns.map((c) => `\`${c}\``).join(", "))}) VALUES (${retryCount + 1}, ${deps.now()}, ${errorClass}, ${postUrl}, ${ping["purchase_id"] ?? null}, ${resourceName}, ${null}, ${ping["subscription_id"] ?? null}, ${false}, ${userId})`,
    );
  });
});
export const postToIndividualPingEndpointWorker = postToIndividualPingEndpointWorkerWith();
