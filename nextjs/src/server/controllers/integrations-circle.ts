// Integrations::CircleController: the seller's setup calls for the Circle integration, as JSON. Each action answers `{ success: false }`
// without asking Circle when an API key (or community) is missing; a request that carries them calls the Circle API (CircleApi) and
// answers the name and id of what it lists.
import { outboundFetch } from "../infra/outbound-http.ts";
import { isHash, parseHttpParty, urlEncode, type ParsedResponse } from "../services/http-party.ts";
import { Ratelimit } from "../services/ratelimit.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { type MutationInput, registerMutations } from "./mutation.ts";
import { isPresent } from "./rails-request.ts";

// `params[name].blank?` for a value Node can compare as Rails does; a list or hash hands back.
function blankParam(input: MutationInput, name: string): boolean {
  const value = input.params[name];
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") throw new HandBackToRails(`a ${name} that is not a string`);
  return !isPresent(value);
}

const CIRCLE_API_URL = "https://app.circle.so/api/v1";
const RATE_LIMIT_KEY = "CIRCLE_API_RATE_LIMIT";
const RATE_LIMIT_THRESHOLD = 100;
const RATE_LIMIT_INTERVAL_SECONDS = 60;

// CircleApi#rate_limited_call
async function rateLimited(call: () => Promise<ParsedResponse>): Promise<ParsedResponse> {
  const ratelimit = new Ratelimit(RATE_LIMIT_KEY);
  return ratelimit.execWithinThreshold(
    RATE_LIMIT_KEY,
    { threshold: RATE_LIMIT_THRESHOLD, interval: RATE_LIMIT_INTERVAL_SECONDS },
    async () => {
      await ratelimit.add(RATE_LIMIT_KEY);
      return call();
    },
  );
}

const circleGet = (apiKey: string, path: string, query?: Record<string, string>) =>
  rateLimited(async () =>
    parseHttpParty(
      await outboundFetch(
        `${CIRCLE_API_URL}${path}${
          query
            ? `?${Object.entries(query)
                .map(([key, value]) => `${urlEncode(key)}=${urlEncode(value)}`)
                .join("&")}`
            : ""
        }`,
        { headers: { Authorization: `Token ${apiKey}` } },
      ),
    ),
  );

// `response.success? && response.parsed_response.kind_of?(Array)`, then `map { |c| c.slice("name", "id") }`.
const isList = (response: ParsedResponse) => response.ok && Array.isArray(response.parsed);

function listOf(response: ParsedResponse): Record<string, unknown>[] | null {
  if (!isList(response)) return null;
  return (response.parsed as unknown[]).map((item) => {
    // Hash#slice raises on anything else (String#slice wants a different arity).
    if (!isHash(item)) throw new Error("Circle answered a list element that is not a JSON object");
    const slice: Record<string, unknown> = {};
    for (const key of ["name", "id"]) if (Object.hasOwn(item, key)) slice[key] = item[key];
    return slice;
  });
}

const apiKeyOf = (input: MutationInput) => input.params.api_key as string;
const communityOf = (input: MutationInput) => input.params.community_id as string;

// `before_action :skip_authorization`: no policy to answer for.
const circle =
  (required: string[], call: (input: MutationInput) => Promise<ActionResult>) =>
  (input: MutationInput): Promise<ActionResult> =>
    sellerJsonAction(
      input,
      () => true,
      () => {
        // `||` in Rails short-circuits left to right, but every operand is only read, so checking all of them is the same.
        if (required.map((name) => blankParam(input, name)).some(Boolean))
          return Promise.resolve(jsonResponse({ success: false }, 200, true));
        return call(input);
      },
    );

registerMutations(
  {
    method: "GET",
    pattern: "/integrations/circle/communities",
    json: true,
    skipForgeryProtection: true,
    run: circle(["api_key"], async (input) => {
      const communities = listOf(await circleGet(apiKeyOf(input), "/communities"));
      return jsonResponse(communities === null ? { success: false } : { success: true, communities }, 200, true);
    }),
  },
  {
    method: "GET",
    pattern: "/integrations/circle/space_groups",
    json: true,
    skipForgeryProtection: true,
    run: circle(["community_id", "api_key"], async (input) => {
      const groups = listOf(await circleGet(apiKeyOf(input), "/space_groups", { community_id: communityOf(input) }));
      return jsonResponse(groups === null ? { success: false } : { success: true, space_groups: groups }, 200, true);
    }),
  },
  {
    method: "GET",
    pattern: "/integrations/circle/communities_and_space_groups",
    json: true,
    skipForgeryProtection: true,
    run: circle(["community_id", "api_key"], async (input) => {
      // Both calls are made before either answer is looked at.
      const communitiesResponse = await circleGet(apiKeyOf(input), "/communities");
      const groupsResponse = await circleGet(apiKeyOf(input), "/space_groups", { community_id: communityOf(input) });
      if (!isList(groupsResponse) || !isList(communitiesResponse)) return jsonResponse({ success: false }, 200, true);
      const communities = listOf(communitiesResponse);
      const groups = listOf(groupsResponse);
      return jsonResponse({ success: true, communities, space_groups: groups }, 200, true);
    }),
  },
);
