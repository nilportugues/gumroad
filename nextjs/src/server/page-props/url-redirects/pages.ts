// UrlRedirectsController pages Next.js serves (GET renders only; streaming, reading and every file delivery
// stay in Rails). Registered in ../pages.ts.
import { railsLoggedInUser } from "../../auth/resolve.ts";
import type { ActionOptions } from "../../controllers/application-controller.ts";
import { queryParam, type RailsRequest } from "../../controllers/rails-request.ts";
import type { ActionContext } from "../load-page.ts";
import type { PageSpec } from "../pages.ts";
import { downloadPageFilters, downloadPageProps, setDownloadPageMeta } from "./download-page.ts";
import { unavailableFilters, unavailablePageProps, unavailableTitle, type UnavailablePage } from "./unavailable.ts";

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const query = (action: ActionContext, name: string) => queryParam({ queryString: action.url.search.replace(/^\?/u, "") } as RailsRequest, name) ?? null;

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
    const token = safeDecode(params.id!);
    await setDownloadPageMeta(action.meta, token, action.config);
    return downloadPageProps(token, { loggedInUser: railsLoggedInUser(action.context), display: query(action, "display"), now: new Date() });
  },
};

export const URL_REDIRECT_PAGES: Record<string, PageSpec> = {
  "/r/:id/expired": unavailablePage("UrlRedirects/Expired", "expired"),
  "/r/:id/rental_expired": unavailablePage("UrlRedirects/RentalExpired", "rental_expired"),
  "/r/:id/membership_inactive": unavailablePage("UrlRedirects/MembershipInactive", "membership_inactive"),
  "/d/:id": downloadPage,
  "/confirm": unavailablePage("UrlRedirects/ConfirmPage", "confirm"),
};
