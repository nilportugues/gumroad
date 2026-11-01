// DiscoverController#index's filters: everything the port cannot answer exactly goes to Rails whole, before the
// page renders. The deferred props and the autocomplete request are Rails'; curated products (a visitor with a
// cart or purchases), the Black Friday page, the affiliate cookie and a card the product presenter cannot build
// are too.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { remoteIp } from "../page-props/audience/events.ts";
import {
  blackFridayFeatureActive,
  type DiscoverRequest,
  hasCuratedProductSources,
  isAutocompleteOnlyRequest,
  isDeferredOnlyRequest,
  prepareSearch,
  requestParams,
  searchResults,
} from "../page-props/discover/discover.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { type ActionOptions, type Chain, type FilterOutcome, HandBackToRails } from "./application-controller.ts";

const GUID_COOKIE = "_gumroad_guid";
const AFFILIATE_PARAMS = ["affiliate_id", "a"];

export function discoverRequestOf(request: Chain["request"], guid: string | null): DiscoverRequest {
  return {
    path: request.path,
    queryString: request.queryString,
    method: request.method,
    headers: request.headers,
    host: request.host,
    hostWithPort: request.hostWithPort,
    protocol: request.protocol,
    remoteIp: remoteIp(request.headers) ?? "127.0.0.1",
    cookies: request.cookies,
    guid,
  };
}

// cookies[:_gumroad_guid] inside the action: the request's cookie, else the one set_gumroad_guid just minted.
export function guidOf(request: Chain["request"], minted: string | null): string | null {
  const sent = request.cookies.get(GUID_COOKIE);
  if (sent) return sent;
  return minted ? (/^_gumroad_guid=([^;]+)/.exec(minted)?.[1] ?? null) : null;
}

export async function discoverFilters(chain: Chain): Promise<FilterOutcome> {
  const { request } = chain;
  // A nested query changes what `params` holds (requestParams refuses it).
  const rawParams = requestParams(request.path, request.queryString);
  if (AFFILIATE_PARAMS.some((name) => name in rawParams)) throw new HandBackToRails();
  if (isDeferredOnlyRequest(request.headers) || isAutocompleteOnlyRequest(request.headers)) throw new HandBackToRails();

  const visitor = railsLoggedInUser(chain.auth.context);
  const guid = guidOf(request, chain.guid);
  if (await hasCuratedProductSources(visitor, guid)) throw new HandBackToRails();
  if (await blackFridayFeatureActive(rawParams)) throw new HandBackToRails();

  const prepared = await prepareSearch(request, visitor);
  try {
    await searchResults(prepared, discoverRequestOf(request, guid));
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails();
    throw error;
  }
  return { state: {} };
}

export const DISCOVER_OPTIONS: ActionOptions = { filters: discoverFilters };
