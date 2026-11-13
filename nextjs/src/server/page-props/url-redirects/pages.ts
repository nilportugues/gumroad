// UrlRedirectsController pages Next.js serves (GET renders only; reading and the file deliveries not listed in
// controllers/url-redirects stay in Rails). Registered in ../pages.ts.
import { railsLoggedInUser } from "../../auth/resolve.ts";
import { HandBackToRails, type ActionOptions } from "../../controllers/application-controller.ts";
import { queryParam, type RailsRequest } from "../../controllers/rails-request.ts";
import type { ActionContext } from "../load-page.ts";
import type { PageSpec } from "../pages.ts";

import { downloadPageFilters, downloadPageProps, POLL_STATE_KEY, setDownloadPageMeta } from "./download-page.ts";
import { PLAY_STATE_KEY, playFilters } from "./play-page.ts";
import { STREAM_STATE_KEY, streamFilters, streamPageProps } from "./player-pages.ts";
import { READ_STATE_KEY, readFilters, readPage } from "./read-page.ts";
import { unavailableFilters, unavailablePageProps, unavailableTitle, type UnavailablePage } from "./unavailable.ts";

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const query = (action: ActionContext, name: string) =>
  queryParam({ queryString: action.url.search.replace(/^\?/u, "") } as RailsRequest, name) ?? null;

function unavailablePage(component: string, page: UnavailablePage): PageSpec {
  const options: ActionOptions = { filters: unavailableFilters(page) };
  return {
    component,
    options,
    props: async (params, action) => {
      const token = page === "confirm" ? (query(action, "id") ?? "") : safeDecode(params.id!);
      action.meta.set({ title: await unavailableTitle(page, token) });
      return unavailablePageProps(page, token, {
        loggedInUser: railsLoggedInUser(action.context),
        display: query(action, "display"),
        destination: query(action, "destination"),
        email: query(action, "email"),
        now: new Date(),
      });
    },
  };
}

// UrlRedirectsController#download_page; the polls, files and rich content stay in Rails.
const downloadPage: PageSpec = {
  component: "UrlRedirects/DownloadPage",
  options: { filters: downloadPageFilters },
  props: async (params, action) => {
    // A poll set no meta tags in Rails and answers only the props it asked for.
    const poll = action.state[POLL_STATE_KEY] as Record<string, unknown> | undefined;
    if (poll !== undefined) return poll;
    const token = safeDecode(params.id!);
    await setDownloadPageMeta(action.meta, token, action.config);
    return downloadPageProps(token, {
      loggedInUser: railsLoggedInUser(action.context),
      display: query(action, "display"),
      now: new Date(),
    });
  },
};

// UrlRedirectsController#stream. The filters build the props (so a hand-back precedes the counted visit) and leave them in the state.
const streamPage: PageSpec = {
  component: "UrlRedirects/Stream",
  options: { filters: streamFilters },
  props: async (params, action) => {
    action.meta.set({ title: "Watch" });
    const built = action.state[STREAM_STATE_KEY];
    if (built !== undefined) return built as Record<string, unknown>;
    return streamPageProps(
      safeDecode(params.id!),
      params.product_file_id === undefined ? undefined : safeDecode(params.product_file_id),
      {
        loggedInUserId: railsLoggedInUser(action.context)?.id ?? null,
      },
    );
  },
};

// UrlRedirectsController#read, built the same way as the stream page.
const readPageSpec: PageSpec = {
  component: "UrlRedirects/Read",
  options: { filters: readFilters },
  props: async (params, action) => {
    const built = action.state[READ_STATE_KEY] as Record<string, unknown> | undefined;
    const props =
      built ??
      (
        await readPage(
          safeDecode(params.id!),
          params.product_file_id === undefined ? undefined : safeDecode(params.product_file_id),
        )
      ).props;
    action.meta.set({ title: props.title as string });
    return props;
  },
};

// UrlRedirectsController#play. Its filters issue the grant and count the visit, so the props are the ones they leave in the state.
const playPageSpec: PageSpec = {
  component: "UrlRedirects/Play",
  options: { filters: playFilters },
  props: (_params, action) => {
    const built = action.state[PLAY_STATE_KEY] as Record<string, unknown> | undefined;
    if (built === undefined) throw new HandBackToRails("the play page without its filter chain");
    action.meta.set({ title: built.title as string });
    return built;
  },
};

export const URL_REDIRECT_PAGES: Record<string, PageSpec> = {
  "/r/:id/expired": unavailablePage("UrlRedirects/Expired", "expired"),
  "/r/:id/rental_expired": unavailablePage("UrlRedirects/RentalExpired", "rental_expired"),
  "/r/:id/membership_inactive": unavailablePage("UrlRedirects/MembershipInactive", "membership_inactive"),
  "/d/:id": downloadPage,
  "/d/:id/play": playPageSpec,
  "/read/:id": readPageSpec,
  "/read/:id/:product_file_id": readPageSpec,
  "/s/:id": streamPage,
  "/s/:id/:product_file_id": streamPage,
  "/confirm": unavailablePage("UrlRedirects/ConfirmPage", "confirm"),
};
