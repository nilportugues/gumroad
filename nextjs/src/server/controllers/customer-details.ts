// CustomersController#customer_charges, #customer_emails, #missed_posts and #product_purchases: the JSON the sale panel of the
// customers page fetches. Reads only; what the data layer cannot answer goes to Rails (page-props/customers/customer-details.ts).
import {
  buildCharges,
  buildCustomerEmails,
  bundleProductPurchaseIds,
  findSaleByEmail,
  findSellerSale,
  missedPosts,
} from "../page-props/customers/customer-details.ts";
import { customersOfPurchases } from "../page-props/customers/customers.ts";
import { domainConfig } from "../page-props/domain.ts";
import { audiencePurchasePolicy } from "../policies/seller-analytics.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { type ActionContext, type ActionResult, HandBackToRails, processAction } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { parseNestedQuery } from "./rails-body.ts";

type Reader = (sellerContext: SellerContext, saleId: string, action: ActionContext) => Promise<unknown>;

// A Rails segment never holds a dot: `/customers/charges/abc.json` is the same route with a format.
function saleIdOf(routeParams: Record<string, string>): string {
  const id = routeParams.purchase_id ?? "";
  if (id.includes(".")) throw new HandBackToRails("a purchase id with a format extension");
  return id;
}

function emailParam(action: ActionContext): string {
  const email = parseNestedQuery(action.request.queryString).purchase_email;
  if (email !== undefined && email !== null && typeof email !== "string")
    throw new HandBackToRails("a purchase_email that is not text");
  return email ?? "";
}

const reader =
  (read: Reader) =>
  (incoming: Request, params: Promise<Record<string, string>>): Promise<Response> =>
    params.then((routeParams) =>
      processAction(incoming, {}, (action): Promise<ActionResult> => {
        const saleId = saleIdOf(routeParams);
        return sellerJsonAction(action, audiencePurchasePolicy.index, async (sellerContext) =>
          jsonResponse(await read(sellerContext, saleId, action)),
        );
      }),
    );

export const customerChargesResponse = reader(async (_, saleId, action) =>
  buildCharges(await findSaleByEmail(emailParam(action), saleId)),
);

// ApplicationController#default_url_options: the request's host and port, DOMAIN on the discover host.
export function receiptUrlOptions(request: ActionContext["request"]) {
  const { protocol, domain, validDiscoverRequestHost } = domainConfig(process.env);
  return { protocol, host: request.host === validDiscoverRequestHost ? domain : request.hostWithPort };
}

export const customerEmailsResponse = reader(async (context, saleId, action) => {
  const seller = context.seller!;
  return buildCustomerEmails(seller, await findSellerSale(seller.id, saleId), receiptUrlOptions(action.request));
});

export const missedPostsResponse = reader(async (_, saleId, action) =>
  missedPosts(await findSaleByEmail(emailParam(action), saleId)),
);

export const productPurchasesResponse = reader(async (context, saleId) =>
  customersOfPurchases(context, await bundleProductPurchaseIds(await findSellerSale(context.seller!.id, saleId))),
);
