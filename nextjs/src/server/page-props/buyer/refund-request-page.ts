// Purchases::RefundRequestsController#show (GET /purchases/:purchase_id/refund_request): the buyer's refund request form, or the
// status of the request they made. The purchase is found by a signed token, so the page needs no session; props in refund-request.ts.
//
// Served for a signed-out visitor. A signed-in one, a preorder charge and a purchase whose money columns the price formatter does
// not read go to Rails before the page renders.
import { railsLoggedInUser } from "../../auth/resolve.ts";
import { HandBackToRails, type Chain, type FilterOutcome } from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import {
  purchaseForRefundRequest,
  refundPeriodInDays,
  REFUND_REQUEST_HEADERS,
} from "../../controllers/purchase-refund-request-guards.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { findRefundRequest } from "../../models/purchase-refund-request.ts";
import { isBlank } from "../../models/runtime/validators.ts";
import { findLink, findUserById } from "../../presenters/product-reads.ts";
import { NotPortedError } from "../not-ported.ts";
import type { PageSpec } from "../pages.ts";

import { refundRequestPageProps, REFUND_REQUEST_COMPONENT } from "./refund-request.ts";

const STATE_KEY = "refundRequestProps";
const SHOW_PATH = /^\/purchases\/([^/.]+)\/refund_request$/u;

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

async function refundRequestFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const routeId = safeDecode(SHOW_PATH.exec(chain.request.path)?.[1] ?? "");
  const purchase = await purchaseForRefundRequest(routeId, chain.now);
  // set_no_store_and_referrer_policy
  for (const [name, value] of Object.entries(REFUND_REQUEST_HEADERS)) chain.headers.set(name, value);
  // set_noindex_header
  chain.headers.set("x-robots-tag", "noindex");
  if (railsLoggedInUser(chain.auth.context) !== null) throw new HandBackToRails("a signed-in visitor");

  const product = purchase.link_id === null ? null : await findLink(purchase.link_id);
  const seller = await findUserById(purchase.seller_id!);
  if (product === null || seller === null)
    throw new HandBackToRails("a purchase whose product or seller row is missing");
  try {
    const props = refundRequestPageProps({
      purchaseRouteId: routeId,
      purchase,
      productName: product.name ?? "",
      sellerName: isBlank(seller.name) ? (seller.username ?? "") : seller.name!,
      refundRequest: await findRefundRequest(purchase.id),
      maxRefundPeriodInDays: await refundPeriodInDays(purchase),
      now: chain.now,
    });
    return { state: { [STATE_KEY]: props } };
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

export const refundRequestPage: PageSpec = {
  component: REFUND_REQUEST_COMPONENT,
  options: { filters: refundRequestFilters },
  props: (_params, action) => {
    const built = action.state[STATE_KEY] as Record<string, unknown> | undefined;
    if (built === undefined) throw new HandBackToRails("the refund request page without its filter chain");
    action.meta.set({ title: "Request a refund" });
    return built;
  },
};
