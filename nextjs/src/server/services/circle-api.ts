// CircleApi (app/services/circle_api.rb) for the two calls the integration jobs make. Both go through the shared
// `CIRCLE_API_RATE_LIMIT` Ratelimit. HTTParty never raises on an HTTP status and nothing reads the response, so the status and body of
// Circle's answer change nothing; only an answer that never arrives does (Ruby raises and Sidekiq retries, Node hands the job back).
import { outboundFetch } from "../infra/outbound-http.ts";
import { HandBackToRuby } from "../jobs/hand-back.ts";

import { urlEncode } from "./http-party.ts";
import { Ratelimit } from "./ratelimit.ts";

const BASE_URI = "https://app.circle.so/api/v1";
const RATE_LIMIT_KEY = "CIRCLE_API_RATE_LIMIT";
const RATE_LIMIT_THRESHOLD = 100;
const RATE_LIMIT_INTERVAL_SECONDS = 60;
// What an API key is made of; anything else could reach Net::HTTP's header line differently than fetch's.
const SAFE_API_KEY = /^[A-Za-z0-9._~+/=-]+$/u;

export type CircleQuery = [string, string][];

// HTTParty's `query:` hash: every key and value through ERB::Util.url_encode, in insertion order (so `space_group_ids[]` goes out with its brackets escaped).
const queryString = (query: CircleQuery) =>
  query.map(([key, value]) => `${urlEncode(key)}=${urlEncode(value)}`).join("&");

export function circleHeader(apiKey: string | null): { Authorization: string } {
  if (apiKey === null || !SAFE_API_KEY.test(apiKey))
    throw new HandBackToRuby("a Circle api key Net::HTTP may send differently");
  return { Authorization: `Token ${apiKey}` };
}

async function rateLimitedCall(
  method: "POST" | "DELETE",
  path: string,
  query: CircleQuery,
  apiKey: string,
): Promise<void> {
  const headers = circleHeader(apiKey);
  const ratelimit = new Ratelimit(RATE_LIMIT_KEY);
  await ratelimit.execWithinThreshold(
    RATE_LIMIT_KEY,
    { threshold: RATE_LIMIT_THRESHOLD, interval: RATE_LIMIT_INTERVAL_SECONDS },
    async () => {
      await ratelimit.add(RATE_LIMIT_KEY);
      let response: Response;
      try {
        response = await outboundFetch(`${BASE_URI}${path}?${queryString(query)}`, { method, headers });
      } catch {
        // Ruby raises on a connection that fails and Sidekiq runs the job again; Rails has the whole job to do over.
        throw new HandBackToRuby("the Circle request got no answer");
      }
      // Rails never reads the body; drain it so the connection is released.
      await response.arrayBuffer().catch(() => undefined);
    },
  );
}

// CircleApi#add_member
export const addMember = (apiKey: string, communityId: string, spaceGroupId: string, email: string) =>
  rateLimitedCall(
    "POST",
    "/community_members",
    [
      ["community_id", communityId],
      ["space_group_ids[]", spaceGroupId],
      ["email", email],
    ],
    apiKey,
  );

// CircleApi#remove_member
export const removeMember = (apiKey: string, communityId: string, email: string) =>
  rateLimitedCall(
    "DELETE",
    "/community_members",
    [
      ["community_id", communityId],
      ["email", email],
    ],
    apiKey,
  );
