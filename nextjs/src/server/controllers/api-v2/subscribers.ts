// Api::V2::SubscribersController (app/controllers/api/v2/subscribers_controller.rb); Subscription#as_json is models/subscription-json.ts.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../../models/sql.ts";
import { ACTIVE_SUBSCRIPTION, subscriptionsAsJson } from "../../models/subscription-json.ts";
import { error400, errorWithObject, fromExternalId, loadProduct, registerApiV2, successWithObject, type ApiV2Input } from "./base.ts";
import { decodePageKey, paginationInfo, USEC_FORMAT } from "./pagination.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RESULTS_PER_PAGE = 100;
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const selectSubscriptions = (where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty) =>
  selectRows<Row>(Prisma.sql`SELECT ${Prisma.raw("`subscriptions`.*")}, DATE_FORMAT(${column("subscriptions", "created_at")}, ${USEC_FORMAT}) AS created_usec FROM ${table("subscriptions")} WHERE ${where}${tail}`);

async function index({ params, request, state }: ApiV2Input) {
  for (const key of ["email", "page_key", "paginated"]) if (params[key] !== undefined && params[key] !== null && typeof params[key] !== "string") return errorHandBack(key);
  const conditions: Prisma.Sql[] = [Prisma.sql`${column("subscriptions", "link_id")} = ${state.product.id}`, ACTIVE_SUBSCRIPTION(new Date())];
  if (present(params.email)) {
    conditions.push(
      Prisma.sql`${column("subscriptions", "id")} IN (SELECT purchases.subscription_id FROM purchases WHERE purchases.email = ${params.email.trim()} AND purchases.subscription_id IS NOT NULL)`,
    );
  }
  if (present(params.page_key)) {
    const decoded = decodePageKey(params.page_key);
    if (decoded === null) return error400("Invalid page_key.");
    conditions.push(Prisma.sql`${column("subscriptions", "created_at")} <= ${decoded.at} AND ${column("subscriptions", "id")} < ${decoded.id}`);
  }
  const order = Prisma.sql` ORDER BY ${column("subscriptions", "created_at")} DESC, ${column("subscriptions", "id")} DESC`;
  const where = Prisma.join(conditions.map((condition) => Prisma.sql`(${condition})`), " AND ");
  if (["1", "true"].includes(params.paginated as string) || present(params.page_key)) {
    const rows = await selectSubscriptions(where, Prisma.sql`${order} LIMIT ${RESULTS_PER_PAGE + 1}`);
    const more = rows.length > RESULTS_PER_PAGE;
    const page = rows.slice(0, RESULTS_PER_PAGE);
    return successWithObject("subscribers", await subscriptionsAsJson(page), more ? paginationInfo(request, page.at(-1) as { created_usec: string; id: bigint }) : {});
  }
  return successWithObject("subscribers", await subscriptionsAsJson(await selectSubscriptions(where, order)));
}

import { HandBackToRails } from "../application-controller.ts";
const errorHandBack = (key: string): never => {
  throw new HandBackToRails(`a non-text ${key} parameter`);
};

async function show({ owner, routeParams }: ApiV2Input) {
  const id = fromExternalId(routeParams.id);
  const [subscription] = id === null ? [] : await selectSubscriptions(Prisma.sql`${column("subscriptions", "id")} = ${id}`, Prisma.sql` LIMIT 1`);
  if (subscription === undefined) return errorWithObject("subscriber");
  // subscription.link.user == current_resource_owner
  const [owned] = await selectRows<Row>(Prisma.sql`SELECT 1 AS owned FROM ${table("links")} WHERE ${column("links", "id")} = ${subscription.link_id} AND ${column("links", "user_id")} = ${owner.id} LIMIT 1`);
  if (owned === undefined) return errorWithObject("subscriber");
  return successWithObject("subscriber", (await subscriptionsAsJson([subscription]))[0]);
}

registerApiV2(
  { method: "GET", pattern: "/v2/products/:link_id/subscribers", scopes: ["view_sales"], before: loadProduct("link_id"), run: index },
  { method: "GET", pattern: "/v2/subscribers/:id", scopes: ["view_sales"], run: show },
);
