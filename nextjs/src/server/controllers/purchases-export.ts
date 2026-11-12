// PurchasesController#export (GET and POST /purchases/export, app/controllers/purchases_controller.rb) and the entry points of
// Exports::PurchaseExportService.export: up to SYNCHRONOUS_EXPORT_THRESHOLD matching sales are returned as a CSV, more (or `force_async`)
// create a SalesExport and enqueue Exports::Sales::CreateAndEnqueueChunksWorker.
//
// Handed to Rails whole, before any write: a signed-out request, the mobile `access_token` form, `in_seller_time_zone`, `variant_ids`, a
// date that is not YYYY-MM-DD, and a result that holds a sale purchase-export-data.ts does not cover.
import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { purchaseExportData } from "../exports/purchase-export-data.ts";
import { purchaseExportCsv } from "../exports/purchase-export.ts";
import {
  queueSalesExport,
  salesExportQuery,
  salesExportSearchOptions,
  type SalesExportFilters,
} from "../exports/sales-export.ts";
import { indexName } from "../infra/elasticsearch.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { audiencePurchasePolicy } from "../policies/seller-analytics.ts";
import { count } from "../search/api.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { json } from "./seller-json.ts";

const SEE_OTHER = 303;
const SYNCHRONOUS_EXPORT_THRESHOLD = 2_000;
const CUSTOMERS_PATH = "/customers";
const EMAIL_NOTICE = "You will receive an email in your inbox with the data you've requested shortly.";
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

// `Date.parse` for the one form the dashboard sends. Anything else (a time, a month name, an impossible day) is Rails' to judge.
function utcDay(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HandBackToRails(`${name} that is not text`);
  const match = DAY.exec(value);
  if (match === null) throw new HandBackToRails(`${name} that is not a YYYY-MM-DD day`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new HandBackToRails(`${name} that is not a real day`);
  return value;
}

// `Link.by_external_ids(filters[:product_ids]).ids`: the products that exist, by id.
async function productIds(value: unknown): Promise<number[] | undefined> {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0))
    return undefined;
  const wanted = Array.isArray(value) ? value : [value];
  if (!wanted.every((entry): entry is string => typeof entry === "string"))
    throw new HandBackToRails("product ids that are not text");
  const ids = wanted.map((externalId) => decrypt(externalId)).filter((id): id is number => id !== null);
  const rows =
    ids.length === 0
      ? []
      : await db.link.findMany({
          where: { id: { in: ids.map(BigInt) } },
          select: { id: true },
          orderBy: { id: "asc" },
        });
  return rows.map((row) => Number(row.id));
}

async function exportPurchases(input: MutationInput): Promise<ActionResult> {
  const loggedIn = railsLoggedInUser(input.context);
  const seller = input.context.currentSeller;
  if (loggedIn === null || seller === null) throw new HandBackToRails("a signed-out request");
  const { params } = input;
  if (params.access_token !== undefined && params.access_token !== null)
    throw new HandBackToRails("the mobile export, which signs in with an access token");
  const wantsJson = requestFormat(input.request) === "json";

  const redirect = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    (context) => authorize(audiencePurchasePolicy.index, context),
  );
  if (redirect !== null) {
    if (wantsJson) throw new HandBackToRails("a refused request that asks for JSON, which Pundit answers with a 401");
    return redirect;
  }

  if (
    params.in_seller_time_zone !== undefined &&
    params.in_seller_time_zone !== null &&
    params.in_seller_time_zone !== ""
  )
    throw new HandBackToRails("an export in the seller's time zone");
  if (
    params.variant_ids !== undefined &&
    params.variant_ids !== null &&
    params.variant_ids !== "" &&
    !(Array.isArray(params.variant_ids) && params.variant_ids.length === 0)
  )
    throw new HandBackToRails("an export filtered by variants");
  const filters: SalesExportFilters = {};
  const startDate = utcDay(params.start_time, "a start_time");
  const endDate = utcDay(params.end_time, "an end_time");
  if (startDate !== undefined) filters.startDate = startDate;
  if (endDate !== undefined) filters.endDate = endDate;
  const products = await productIds(params.product_ids);
  if (products !== undefined) filters.productIds = products;
  const forceAsync = params.force_async !== undefined && params.force_async !== null && params.force_async !== "";

  const options = salesExportSearchOptions(Number(seller.id), filters);
  const search = new PurchaseSearchService(options);
  const counted = await count({ index: indexName("Purchase"), body: { query: search.body.query } as never });
  const total = Number((counted.body as { count: number }).count);

  if (total <= SYNCHRONOUS_EXPORT_THRESHOLD && !forceAsync) {
    const result = await PurchaseSearchService.process(options);
    const ids = result.ids.map(BigInt);
    const purchases =
      ids.length === 0 ? [] : await db.purchase.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    const data = await purchaseExportData(purchases);
    return {
      status: 200,
      body: purchaseExportCsv(data.customFields, data.rows),
      contentType: "text/csv",
      headers: {
        "Content-Disposition": "attachment; filename=\"Sales.csv\"; filename*=UTF-8''Sales.csv",
        "Content-Transfer-Encoding": "binary",
      },
    };
  }

  // `recipient: impersonating_user || logged_in_user`
  const recipient = input.context.impersonatedUser ?? loggedIn;
  await queueSalesExport(BigInt(recipient.id), salesExportQuery(Number(seller.id), filters));
  if (wantsJson) return json({ success: true });
  return { status: SEE_OTHER, location: CUSTOMERS_PATH, flash: { notice: EMAIL_NOTICE } };
}

registerMutations(
  {
    method: "GET",
    pattern: "/purchases/export",
    skipForgeryProtection: true,
    formats: ["html", "json"],
    run: exportPurchases,
  },
  { method: "POST", pattern: "/purchases/export", formats: ["html", "json"], run: exportPurchases },
);
