// Rack::Attack in front of a Node-served action: counts the request in Rails' Redis (infra/rack-attack.ts) and answers its 429.
import {
  countThrottles,
  normalizePath,
  type RackAttackOutcome,
  type ThrottleRequest,
  throttledResponse,
} from "../infra/rack-attack.ts";

import { parseNestedQuery, type Params } from "./rails-body.ts";

const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded\b/iu;

// Rack's `req.params`: the query string merged with a form-encoded body (a JSON body is not parsed by Rack, only by Rails later). A
// key Rack parses in a way parseNestedQuery does not model leaves its params empty, like a request the throttle cannot key.
export function throttleRequest(incoming: Request): ThrottleRequest {
  const url = new URL(incoming.url);
  let params: Promise<Params> | undefined;
  const read = async (): Promise<Params> => {
    try {
      const query = parseNestedQuery(url.search.replace(/^\?/u, ""));
      const contentType = incoming.headers.get("content-type") ?? "";
      if (!FORM_CONTENT_TYPE.test(contentType) || incoming.body === null) return query;
      return { ...query, ...parseNestedQuery(await incoming.clone().text()) };
    } catch {
      return {};
    }
  };
  return {
    method: incoming.method,
    path: normalizePath(url.pathname),
    headers: incoming.headers,
    params: () => (params ??= read()),
  };
}

export type CountedRequest = Pick<RackAttackOutcome, "undo"> & { throttled: Response | null };

export async function rackAttack(incoming: Request): Promise<CountedRequest> {
  const outcome = await countThrottles(throttleRequest(incoming));
  return { undo: outcome.undo, throttled: outcome.throttled ? throttledResponse(outcome.throttled.retryAfter) : null };
}
