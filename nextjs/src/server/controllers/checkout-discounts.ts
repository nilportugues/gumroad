// Checkout::DiscountsController (app/controllers/checkout/discounts_controller.rb): #index, #paged and #statistics run in Node.
// #create, #update and #destroy stay in Rails whole: they run OfferCode's validations against live product defaults and enqueue
// ReindexSellerOfferCodesJob through a Redis script, which the port does not reproduce.
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { fetchOfferCodes, offerCodeProps, offerCodeStatistics, type ListingParams } from "../presenters/discounts.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { checkoutOfferCodePolicy } from "../policies/checkout-offer-code.ts";
import { authorize } from "../policies/authorize.ts";
import { Prisma, type OfferCode } from "@prisma/client";

import { HandBackToRails, RoutingError, processAction, type ActionContext, type ActionOptions } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { parseNestedQuery, type Params } from "./rails-body.ts";
import { authorizeJson } from "./seller-json.ts";
import { rubyToI } from "../models/concerns/ruby-numeric.ts";

const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HandBackToRails(`a non-scalar ${name}`);
  return value;
};

// `fetch_offer_codes`'s reading of params: `column` + `sort` become `sort[key]`/`sort[direction]`, and `paged_params` drops what is not a scalar.
export function listingParams(params: Params): ListingParams {
  const column = text(params.column, "column");
  const sortParam = params.sort;
  let sort: Params = {};
  if (column !== null && column.trim() !== "" && sortParam !== undefined && sortParam !== null && sortParam !== "") {
    sort = { key: column, direction: text(sortParam, "sort") };
  } else if (sortParam !== undefined && sortParam !== null && typeof sortParam === "object" && !Array.isArray(sortParam)) {
    sort = sortParam as Params;
  } else if (typeof sortParam !== "string" && sortParam !== undefined && sortParam !== null) {
    throw new HandBackToRails("a sort that is neither a hash nor text");
  }
  const query = text(params.query, "query");
  return {
    page: rubyToI(text(params.page, "page")),
    query: query === null || query.trim() === "" ? null : query,
    sort: { key: text(sort.key, "sort key") ?? undefined, direction: text(sort.direction, "sort direction") ?? undefined },
  };
}

export const DISCOUNTS_PAGED_OPTIONS: ActionOptions = {};

async function paged(action: ActionContext) {
  const paramsRead = false;
  return sellerJsonAction(action, checkoutOfferCodePolicy.paged, async (sellerContext) => {
    const listing = await fetchOfferCodes(sellerContext.seller!, listingParams(parseNestedQuery(action.request.queryString)));
    return jsonResponse({ offer_codes: listing.codes.map((code) => offerCodeProps(code, sellerContext.seller!, sellerContext)), pagination: listing.pagination }, 200, paramsRead);
  }, { paramsRead });
}

async function statistics(action: ActionContext, externalId: string) {
  return sellerJsonAction(action, () => true, async (sellerContext) => {
    // `current_seller.offer_codes.find_by_external_id!`, deleted codes included; the lookup runs ahead of `authorize`.
    const id = decrypt(externalId);
    const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`offer_codes`.*")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${sellerContext.seller!.id} AND ${column("offer_codes", "id")} = ${id} LIMIT 1`);
    if (row === undefined) throw new RoutingError("Not Found");
    const code = castRow<OfferCode>("OfferCode", row);
    const denied = await authorizeJson(action, () => authorize(checkoutOfferCodePolicy.statistics, sellerContext, { user_id: code.user_id }));
    if (denied) return denied;
    return jsonResponse(await offerCodeStatistics(code.id));
  });
}

export const discountsPagedResponse = (incoming: Request): Promise<Response> => processAction(incoming, DISCOUNTS_PAGED_OPTIONS, paged);
export const discountStatisticsResponse = (incoming: Request, externalId: string): Promise<Response> =>
  processAction(incoming, DISCOUNTS_PAGED_OPTIONS, (action) => statistics(action, externalId));
