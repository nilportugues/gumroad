// `CommunityChannel.broadcast_to("community_<id>", payload)` in production: ActionCable's `any_cable` adapter hands the stream and the
// JSON-encoded payload to AnyCable's `redisx` broadcaster, which appends them to a Redis stream the AnyCable server reads.
// Golden: __fixtures__/anycable.golden.json (scripts/golden/anycable.rb runs the real gems).
import { Redis } from "ioredis";

import { notifyError } from "./error-reporting.ts";
import { NotPortedError } from "../models/user.ts";

// AnyCable.config.redis_channel, the stream the server consumes
const DEFAULT_STREAM = "__anycable__";
const COMMUNITY_CHANNEL = "community";

// ActiveSupport::JSON.encode: `<`, `>`, `&` and the JS line separators are written as \u escapes.
const ESCAPED = new RegExp("[<>&\\u2028\\u2029]", "gu");
export function activeSupportJson(value: unknown): string {
  return JSON.stringify(value).replace(ESCAPED, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

let client: Redis | null = null;

// The connection AnyCable.config.redis_url (ANYCABLE_REDIS_URL, else REDIS_URL) names. A deployment that sets neither broadcasts
// somewhere Node cannot tell, so the request goes to Rails whole.
function anycableRedis(): Pick<Redis, "xadd"> {
  const url = process.env.ANYCABLE_REDIS_URL ?? process.env.REDIS_URL;
  if (url === undefined) throw new NotPortedError("CommunityChannel.broadcast_to", "AnyCable's Redis is not configured (ANYCABLE_REDIS_URL or REDIS_URL)");
  return (client ??= new Redis(url, { lazyConnect: true }));
}

// Call before the first write of an action that broadcasts.
export function assertCanBroadcast(): void {
  anycableRedis();
}

// `broadcast_message`: a failed broadcast is logged and reported, never raised.
export async function broadcastToCommunity(communityExternalId: string, payload: unknown, redis: Pick<Redis, "xadd"> = anycableRedis()): Promise<void> {
  try {
    const stream = `${COMMUNITY_CHANNEL}:community_${communityExternalId}`;
    await redis.xadd(process.env.ANYCABLE_REDIS_CHANNEL ?? DEFAULT_STREAM, "*", "payload", JSON.stringify({ stream, data: activeSupportJson(payload) }));
  } catch (error) {
    console.error(`Error broadcasting message to community channel: ${(error as Error).message}`);
    notifyError(error);
  }
}
