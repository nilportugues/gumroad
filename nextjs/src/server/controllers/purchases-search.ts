// PurchasesController#search (app/controllers/purchases_controller.rb): the customers search box. The query goes to Elasticsearch and
// to the seller's imported customers; the answer is the rows' JSON (Purchase#as_json version 2 with the receipt URL, the ping flag and
// the variant details).
//
// Served in Node when nothing matches (`[]`). Handed to Rails whole once a purchase or an imported customer matches, as is a request
// that is not JSON and a `page` or `query` that is not text; the rows' serializer is not ported.
import { Prisma } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { paramToI } from "../page-props/audience/support.ts";
import { authorize } from "../policies/authorize.ts";
import { audiencePurchasePolicy } from "../policies/seller-analytics.ts";
import { ALL_SUCCESS_STATES, PurchaseSearchService } from "../search/purchase-search.ts";
import { rubyStrip } from "../search/ruby-params.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { authorizeJson } from "./seller-json.ts";

const SEARCH_RESULTS_PER_PAGE = 100;
// ES rejects from + size past index.max_result_window.
const MAX_RESULT_WINDOW = 10_000;

const optionalText = (input: MutationInput, key: string, reason: string): string | undefined => {
  const value = input.params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HandBackToRails(reason);
  return value;
};

async function search(input: MutationInput): Promise<ActionResult> {
  const seller = input.context.currentSeller;
  if (railsLoggedInUser(input.context) === null || seller === null) throw new HandBackToRails("a signed-out request");
  // Pundit answers a request that is not JSON with a redirect, which stays with Rails.
  if (requestFormat(input.request) !== "json") throw new HandBackToRails("a search that does not ask for JSON");
  const denied = await authorizeJson(input, (context) => authorize(audiencePurchasePolicy.index, context));
  if (denied) return denied;

  const pageText = optionalText(input, "page", "a page that is not text");
  const queryText = optionalText(input, "query", "a query that is not text");
  // A malformed or zero page would send ES a negative offset, so it is clamped into the legal window.
  const page = Math.min(
    Math.max(pageText === undefined ? 0 : paramToI(pageText), 1),
    MAX_RESULT_WINDOW / SEARCH_RESULTS_PER_PAGE,
  );
  const offset = (page - 1) * SEARCH_RESULTS_PER_PAGE;
  const query = rubyStrip(queryText ?? "");

  const result = await PurchaseSearchService.process({
    seller: { id: Number(seller.id) },
    seller_query: query,
    state: [...ALL_SUCCESS_STATES],
    exclude_non_original_subscription_purchases: true,
    exclude_commission_completion_purchases: true,
    from: offset,
    size: SEARCH_RESULTS_PER_PAGE,
    sort: ["_score", { created_at: "desc" }, { id: "desc" }],
  });
  if (result.ids.length > 0)
    throw new HandBackToRails("a search that matches purchases, which the receipt serializer renders");

  const imported = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("imported_customers")} WHERE ${column("imported_customers", "importing_user_id")} = ${seller.id} AND ${column("imported_customers", "deleted_at")} IS NULL AND ${column("imported_customers", "email")} LIKE ${`%${query}%`} ORDER BY ${column("imported_customers", "id")} DESC LIMIT ${SEARCH_RESULTS_PER_PAGE} OFFSET ${offset}`,
  );
  if (imported.length > 0) throw new HandBackToRails("a search that matches imported customers");

  // Recorded: Rails answers Vary: Accept here.
  return jsonResponse([]);
}

registerMutations({ method: "GET", pattern: "/purchases/search", skipForgeryProtection: true, run: search });
