// The Discover pages: /discover and the taxonomy pages (`/*taxonomy`, only for paths that are taxonomies).
// DiscoverController#index; the filters are in controllers/discover-page.ts.
import { railsLoggedInUser } from "../../auth/resolve.ts";
import { DISCOVER_OPTIONS } from "../../controllers/discover-page.ts";
import { remoteIp } from "../audience/events.ts";
import type { PageSpec } from "../pages.ts";

import type { BlackFridayStats } from "./black-friday-stats.ts";
import {
  autocompleteResults,
  createDiscoverSearch,
  type DiscoverRequest,
  deferredProps,
  discoverProps,
  isAutocompleteOnlyRequest,
  isDeferredOnlyRequest,
  isSearching,
  prepareSearch,
  requestParams,
  searchResults,
  setMetaTags,
} from "./discover.ts";

const discoverPage: PageSpec = {
  component: "Discover/Index",
  buyerCurrencyFooter: true,
  options: DISCOVER_OPTIONS,
  props: async (_, action) => {
    const { url, headers, context, meta, state } = action;
    const visitor = railsLoggedInUser(context);
    const sent = /(?:^|;\s*)_gumroad_guid=([^;]+)/u.exec(headers.get("cookie") ?? "")?.[1];
    const guid = sent ? decodeURIComponent(sent) : (action.renderState?.mintedGuid ?? null);
    const queryString = url.search.replace(/^\?/u, "");
    const request: DiscoverRequest = {
      path: url.pathname,
      queryString,
      method: "GET",
      headers,
      host: url.hostname,
      hostWithPort: url.host,
      protocol: `${url.protocol}//`,
      remoteIp: remoteIp(headers) ?? "127.0.0.1",
      cookies: new Map<string, string | null>(),
      guid,
      currentSellerId: context.currentSeller?.id ?? null,
    };
    if (isAutocompleteOnlyRequest(headers)) {
      // create_discover_search! comes first, and only for a present query.
      const params = requestParams(request.path, queryString);
      if (typeof params.query === "string" && params.query.trim() !== "")
        await createDiscoverSearch(
          { query: params.query, taxonomyId: null, autocomplete: true },
          request,
          visitor,
          params,
        );
      return { autocomplete_results: state.autocomplete ?? (await autocompleteResults(params, visitor, guid)) };
    }
    const prepared = await prepareSearch(request, visitor);
    if (isDeferredOnlyRequest(headers)) {
      for (const key of meta.keys()) meta.remove(key);
      return deferredProps(prepared, request, visitor);
    }
    const results = await searchResults(prepared, request);
    if (isSearching(prepared.params)) {
      const query = prepared.params.query;
      await createDiscoverSearch(
        {
          query: query === undefined || query === null ? null : String(query),
          taxonomyId: prepared.taxonomy?.id ?? null,
        },
        request,
        visitor,
        prepared.params,
      );
    }
    setMetaTags(meta, prepared, results, visitor !== null, queryString);
    return discoverProps(prepared, results, visitor, request, state.blackFridayStats as BlackFridayStats | null);
  },
};

export const DISCOVER_PAGES: Record<string, PageSpec> = {
  "/discover": discoverPage,
  "/*taxonomy": discoverPage,
};
