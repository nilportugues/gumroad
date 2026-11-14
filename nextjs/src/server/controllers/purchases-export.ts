// PurchasesController#export (GET and POST /purchases/export, app/controllers/purchases_controller.rb) and the entry points of
// Exports::PurchaseExportService.export: up to SYNCHRONOUS_EXPORT_THRESHOLD matching sales are returned as a CSV, more (or `force_async`)
// create a SalesExport and enqueue Exports::Sales::CreateAndEnqueueChunksWorker.
//
// Handed to Rails whole, before any write: the mobile `access_token` form with the right `mobile_token` (a wrong one falls through to
// the login redirect, as in Rails), an `in_seller_time_zone` that is not a plain word or a seller
// whose time zone name ActiveSupport::TimeZone::MAPPING does not hold, a date that is not an ISO day (optionally followed by a time of day),
// and a result that holds a sale purchase-export-data.ts does not cover.
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
import { getConfig } from "../infra/config.ts";
import { indexName } from "../infra/elasticsearch.ts";
import { isKnownTimeZone } from "../models/concerns/rails-time-zone.ts";
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
import { signedOutRefusal } from "./wishlists-mutations.ts";

const SEE_OTHER = 303;
const SYNCHRONOUS_EXPORT_THRESHOLD = 2_000;
const CUSTOMERS_PATH = "/customers";
const EMAIL_NOTICE = "You will receive an email in your inbox with the data you've requested shortly.";
const PLAIN_WORD = /^[\w-]+$/u;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
// A day followed by a time of day, which `Date.parse` reads and drops: `T` or a space, hh:mm[:ss[.fraction]], then an optional ±hh:mm offset (a `Z` is left to Rails).
const DAY_WITH_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/u;

// `Date.parse` for an ISO day, with or without a time of day (the time and offset do not move the day). Anything else (a month name, an
// impossible day) is Rails' to judge.
function utcDay(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HandBackToRails(`${name} that is not text`);
  const day = DAY_WITH_TIME.exec(value)?.[1] ?? value;
  const match = DAY.exec(day);
  if (match === null) throw new HandBackToRails(`${name} that is not an ISO day`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== day) throw new HandBackToRails(`${name} that is not a real day`);
  return day;
}

// Ruby's `blank?` for a string of ASCII whitespace only (`[[:space:]]` also holds Unicode spaces, which Rails keeps).
const ASCII_BLANK = /^[\t-\r ]+$/u;

// `params[:in_seller_time_zone].present?`. Only a plain word or ASCII whitespace is judged here; Unicode and structures are Rails' to read.
export function presentFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "string" && ASCII_BLANK.test(value)) return false;
  if (typeof value !== "string" || !PLAIN_WORD.test(value))
    throw new HandBackToRails("an in_seller_time_zone that is not a plain word");
  return true;
}

// `Link.by_external_ids(ids).ids` / `BaseVariant.by_external_ids(ids).ids`: the rows that exist, by id (deleted ones included, as no
// scope is applied).
async function existingIds(
  value: unknown,
  find: (ids: number[]) => Promise<{ id: bigint | number }[]>,
): Promise<number[] | undefined> {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0))
    return undefined;
  const wanted = Array.isArray(value) ? value : [value];
  if (!wanted.every((entry): entry is string => typeof entry === "string"))
    throw new HandBackToRails("ids that are not text");
  const ids = wanted.map((externalId) => decrypt(externalId)).filter((id): id is number => id !== null);
  const rows = ids.length === 0 ? [] : await find(ids);
  return rows.map((row) => Number(row.id));
}

const productIds = (value: unknown) =>
  existingIds(value, (ids) =>
    db.link.findMany({ where: { id: { in: ids.map(BigInt) } }, select: { id: true }, orderBy: { id: "asc" } }),
  );
const variantIds = (value: unknown) =>
  existingIds(value, (ids) =>
    db.baseVariant.findMany({ where: { id: { in: ids } }, select: { id: true }, orderBy: { id: "asc" } }),
  );

// `params[key].present?` for a string; anything else is Rails' to read.
function presentText(value: unknown, name: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "string") throw new HandBackToRails(`${name} that is not text`);
  return !/^\p{White_Space}*$/u.test(value);
}

async function exportPurchases(input: MutationInput): Promise<ActionResult> {
  const { params } = input;
  // authenticate_mobile_export! runs first and signs in a signed-out request that carries the mobile token and a valid access token.
  if (railsLoggedInUser(input.context) === null && presentText(params.access_token, "an access_token")) {
    const known = getConfig("MOBILE_TOKEN");
    if (known === undefined) throw new HandBackToRails("MOBILE_TOKEN is not configured");
    const given = params.mobile_token ?? "";
    if (typeof given !== "string") throw new HandBackToRails("a mobile_token that is not text");
    if (given === known) throw new HandBackToRails("the mobile export, which signs in with an access token");
  }
  const signedOut = signedOutRefusal(input);
  if (signedOut !== null) return signedOut;
  const loggedIn = railsLoggedInUser(input.context);
  const seller = input.context.currentSeller;
  if (loggedIn === null || seller === null) throw new HandBackToRails("a signed-in request without a seller");
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

  const inSellerTimeZone = presentFlag(params.in_seller_time_zone);
  const filters: SalesExportFilters = {};
  if (inSellerTimeZone) {
    // `ActiveSupport::TimeZone[seller.timezone]` is nil for a name it does not know, which Rails reads as UTC; not proven here.
    const timezone = seller.timezone;
    if (!isKnownTimeZone(timezone))
      throw new HandBackToRails("an export in a seller's time zone that ActiveSupport does not map");
    filters.timeZone = timezone;
  }
  const startDate = utcDay(params.start_time, "a start_time");
  const endDate = utcDay(params.end_time, "an end_time");
  if (startDate !== undefined) filters.startDate = startDate;
  if (endDate !== undefined) filters.endDate = endDate;
  const products = await productIds(params.product_ids);
  if (products !== undefined) filters.productIds = products;
  const variants = await variantIds(params.variant_ids);
  if (variants !== undefined) filters.variantIds = variants;
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
