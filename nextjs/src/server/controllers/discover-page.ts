// DiscoverController#index's filters: everything the port cannot answer exactly goes to Rails whole, before the
// page renders. The deferred props and the autocomplete request the port cannot answer are Rails'; curated products
// (a visitor whose cart has alive products or who has purchases), the Black Friday page and a card the product presenter
// cannot build are too.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { remoteIp } from "../page-props/audience/events.ts";
import {
  autocompleteResults,
  blackFridayFeatureActive,
  deferredPropsPortable,
  type DiscoverRequest,
  hasCuratedProductSources,
  isAutocompleteOnlyRequest,
  isDeferredOnlyRequest,
  prepareSearch,
  requestedDeferredProps,
  requestParams,
  searchResults,
} from "../page-props/discover/discover.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { affiliateCookieForParams } from "./affiliate-redirect.ts";
import { type ActionOptions, type Chain, type FilterOutcome, HandBackToRails } from "./application-controller.ts";

const GUID_COOKIE = "_gumroad_guid";
export function discoverRequestOf(
  request: Chain["request"],
  guid: string | null,
  currentSellerId: bigint | null,
): DiscoverRequest {
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
    currentSellerId,
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
  // before_action :set_affiliate_cookie runs ahead of every branch below, the search box and deferred fetches included.
  const affiliateCookie = await affiliateCookieForParams(request, chain.now);
  if (affiliateCookie !== null) chain.cookies.push(affiliateCookie);
  const deferredOnly = isDeferredOnlyRequest(request.headers);

  const visitor = railsLoggedInUser(chain.auth.context);
  const guid = guidOf(request, chain.guid);
  const currentSellerId = chain.auth.context.currentSeller?.id ?? null;
  if (isAutocompleteOnlyRequest(request.headers)) {
    // The search box answers before format_search_params!, the curated products and the Black Friday check.
    try {
      return { state: { autocomplete: await autocompleteResults(rawParams, visitor, guid) } };
    } catch (error) {
      if (error instanceof NotPortedError) throw new HandBackToRails();
      throw error;
    }
  }
  if (await hasCuratedProductSources(visitor, guid)) throw new HandBackToRails();
  if (await blackFridayFeatureActive(rawParams)) throw new HandBackToRails();

  const prepared = await prepareSearch(request, visitor);
  if (deferredOnly) {
    if (
      !(await deferredPropsPortable(
        requestedDeferredProps(request.headers),
        prepared,
        visitor,
        guid,
        discoverRequestOf(request, guid, currentSellerId),
      ))
    )
      throw new HandBackToRails();
    return { state: {} };
  }
  try {
    await searchResults(prepared, discoverRequestOf(request, guid, currentSellerId));
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails();
    throw error;
  }
  return { state: {} };
}

export const DISCOVER_OPTIONS: ActionOptions = { filters: discoverFilters };
