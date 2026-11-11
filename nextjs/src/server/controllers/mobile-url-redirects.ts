// Api::Mobile::UrlRedirectsController#fetch_placeholder_products. Only the mobile token is checked (no OAuth scope), and the answer is
// always an empty list.
import { db } from "../../lib/db.ts";
import { UrlRedirectFlags } from "../models/url-redirect.ts";
import { membershipInactive } from "../page-props/url-redirects/download-page.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails, type Rendered } from "./application-controller.ts";
import { fetchError, registerMobile, renderJson, UNAUTHORIZED, type MobileAction } from "./mobile-api.ts";

export const FETCH_PLACEHOLDER_PRODUCTS: MobileAction = {
  method: "GET",
  pattern: "/mobile/url_redirects/fetch_placeholder_products",
  scopes: null,
  run: async () => renderJson({ success: true, placeholder_products: [] }),
};

registerMobile(FETCH_PLACEHOLDER_PRODUCTS);

// Api::Mobile::UrlRedirectsController#stream, #hls_playlist and #download: fetch_url_redirect_by_token, check_permissions and
// check_for_expired_rentals. Past them the actions pick the product file, sign a CloudFront or S3 URL, build the playlist and
// write the use count and consumption event, so a request that passes goes to Rails untouched.
const NO_URL_REDIRECT = "Could not find url redirect";
const RENTAL_EXPIRED = "Your rental has expired.";

export async function deliveryGate(
  token: string,
  { writesRentalStamp, now }: { writesRentalStamp: boolean; now: Date },
): Promise<Rendered | null> {
  const redirect = await db.urlRedirect.findUnique({ where: { token } });
  if (!redirect) return fetchError(NO_URL_REDIRECT);

  const purchase =
    redirect.purchase_id === null ? null : await db.purchase.findUnique({ where: { id: redirect.purchase_id } });
  if (purchase) {
    const withdrawn =
      purchase.stripe_refunded === true ||
      (purchase.chargeback_date !== null && !PurchaseFlags.isSet(purchase.flags, "chargeback_reversed"));
    const subscription =
      purchase.subscription_id === null
        ? null
        : await db.subscription.findUnique({ where: { id: purchase.subscription_id } });
    const product = purchase.link_id === null ? null : await db.link.findUnique({ where: { id: purchase.link_id } });
    if (
      withdrawn ||
      PurchaseFlags.isSet(purchase.flags, "is_access_revoked") ||
      (await membershipInactive({ subscription, product }, now))
    )
      return fetchError(NO_URL_REDIRECT);
  }

  const isRental = UrlRedirectFlags.isSet(redirect.flags, "is_rental");
  // mark_rental_as_viewed! stamps the first view ahead of the expiry check.
  if (writesRentalStamp && isRental && redirect.rental_first_viewed_at === null)
    throw new HandBackToRails("a rental's first view stamp");
  if (isRental && purchase?.rental_expired === true) return fetchError(RENTAL_EXPIRED, UNAUTHORIZED);
  return null;
}

const deliveryAction = (pattern: string, writesRentalStamp: boolean): MobileAction => ({
  method: "GET",
  pattern,
  scopes: null,
  run: async (input) => {
    const refused = await deliveryGate(input.routeParams.token!, { writesRentalStamp, now: new Date() });
    if (refused !== null) return refused;
    throw new HandBackToRails("a mobile delivery past the access gate");
  },
});

export const STREAM = deliveryAction("/mobile/url_redirects/stream/:token/:product_file_id", false);
export const HLS_PLAYLIST = deliveryAction(
  "/mobile/url_redirects/hls_playlist/:token/:product_file_id/index.m3u8",
  true,
);
export const DOWNLOAD = deliveryAction("/mobile/url_redirects/download/:token/:product_file_id", false);

registerMobile(STREAM, HLS_PLAYLIST, DOWNLOAD);
