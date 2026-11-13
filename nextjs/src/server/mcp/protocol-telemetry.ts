// Port of app/services/mcp/protocol_telemetry.rb. One Redis hash per UTC day, one field per connector|version|method bucket, with the
// same Lua script, retention and 250 ms timeout as Rails, so both apps feed the same counters.
import { Redis } from "ioredis";

import { redisUrl } from "../infra/redis.ts";

import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./constants.ts";

export const CONNECTORS = ["muse", "claude", "chatgpt"];
// Every published revision, so a client declaring one we do not serve is still named.
const VERSIONS = [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION, "2024-11-05", "2025-06-18", "2025-11-25"];
const METHODS = [
  "initialize",
  "notifications/cancelled",
  "notifications/initialized",
  "ping",
  "server/discover",
  "tools/call",
  "tools/list",
];
export const UNDECLARED = "undeclared";
const OTHER = "other";
const SEPARATOR = "|";
// 90.days.to_i
const RETENTION_SECONDS = 7_776_000;
// Rails' TIMEOUT = 0.25: a stalled Redis costs a connector request at most this much.
const TIMEOUT_MS = 250;

// Counts and retention land in one atomic step, so a day is never left without its expiry.
const INCREMENT_SCRIPT = `
for i = 2, #ARGV, 2 do
  redis.call("HINCRBY", KEYS[1], ARGV[i], ARGV[i + 1])
end
return redis.call("EXPIRE", KEYS[1], ARGV[1])
`;

// The version|method part of a field, bucketed per message.
export function protocolBucket(declaredVersion: string | null, method: unknown): string {
  const version = declaredVersion === null ? UNDECLARED : VERSIONS.includes(declaredVersion) ? declaredVersion : OTHER;
  const bucketMethod = typeof method === "string" && METHODS.includes(method) ? method : OTHER;
  return [version, bucketMethod].join(SEPARATOR);
}

export const protocolRequestsKey = (date: Date): string => `mcp:protocol_requests:${date.toISOString().slice(0, 10)}`;

// No reconnects: a retried EVAL whose reply was lost would count twice. Built lazily so importing this module opens no socket.
let client: Redis | null = null;
function telemetryRedis(): Redis {
  client ??= new Redis(redisUrl("main"), {
    lazyConnect: true,
    commandTimeout: TIMEOUT_MS,
    connectTimeout: TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  return client;
}

// One write per HTTP request, best effort: telemetry never fails a connector request.
export async function recordProtocolTelemetry(
  connector: string | null,
  counts: ReadonlyMap<string, number>,
  redis: Pick<Redis, "eval"> = telemetryRedis(),
  now = new Date(),
): Promise<void> {
  if (counts.size === 0 || connector === null || !CONNECTORS.includes(connector)) return;
  const pairs = [...counts].flatMap(([bucket, count]) => [`${connector}${SEPARATOR}${bucket}`, String(count)]);
  try {
    await redis.eval(INCREMENT_SCRIPT, 1, protocolRequestsKey(now), String(RETENTION_SECONDS), ...pairs);
  } catch (error) {
    console.warn(`mcp_protocol_telemetry_failed ${(error as Error).name}`);
  }
}
