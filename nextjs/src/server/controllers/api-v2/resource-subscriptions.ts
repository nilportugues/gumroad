// Api::V2::ResourceSubscriptionsController#index and #destroy (app/controllers/api/v2/resource_subscriptions_controller.rb).
// #create resolves the post URL's host through DNS (SsrfFilter's reserved ranges) and #test_event delivers an HTTP request; both stay in Rails.
import { Prisma, type ResourceSubscription } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { castRow, column, execute, selectRows, table } from "../../models/sql.ts";
import { errorWithObject, fromExternalId, registerApiV2, renderResponse, successWithObject } from "./base.ts";

const RESOURCE_SUBSCRIPTIONS = "resource_subscriptions";
// ResourceSubscription::VALID_RESOURCE_NAMES
const VALID_RESOURCE_NAMES = ["sale", "cancellation", "subscription_ended", "subscription_restarted", "subscription_updated", "refund", "dispute", "dispute_won"];
// ActiveModel::Type::Boolean::FALSE_VALUES
const FALSE_VALUES = new Set([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
const castBoolean = (value: unknown) => (value === null || value === undefined || value === "" ? null : !FALSE_VALUES.has(value as never));

const json = (row: ResourceSubscription) => ({ id: encrypt(row.id), resource_name: row.resource_name, post_url: row.post_url });

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/resource_subscriptions",
    scopes: ["view_sales"],
    async run({ owner, params, token }) {
      const resourceName = params.resource_name;
      if (typeof resourceName !== "string" || !VALID_RESOURCE_NAMES.includes(resourceName)) return renderResponse(false, { message: "Valid resource_name parameter required" });

      const conditions = [
        Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "user_id")} = ${owner.id}`,
        Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "deleted_at")} IS NULL`,
        Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "resource_name")} = ${resourceName}`,
      ];
      if (castBoolean(params.current_oauth_application_only)) conditions.push(Prisma.sql`${column(RESOURCE_SUBSCRIPTIONS, "oauth_application_id")} = ${token.application_id}`);
      const rows = await selectRows(Prisma.sql`SELECT ${table(RESOURCE_SUBSCRIPTIONS)}.* FROM ${table(RESOURCE_SUBSCRIPTIONS)} WHERE ${Prisma.join(conditions, " AND ")} ORDER BY ${column(RESOURCE_SUBSCRIPTIONS, "id")}`);
      return successWithObject("resource_subscriptions", rows.map((row) => json(castRow<ResourceSubscription>("ResourceSubscription", row))));
    },
  },
  {
    method: "DELETE",
    pattern: "/v2/resource_subscriptions/:id",
    scopes: ["view_sales"],
    async run({ routeParams, token }) {
      const id = fromExternalId(routeParams.id);
      const found = id === null ? null : await db.resourceSubscription.findUnique({ where: { id } });
      if (found === null || token.application_id !== found.oauth_application_id) return errorWithObject("resource_subscription");
      // Deletable#mark_deleted!: Time.current, cast to the column's precision (seconds)
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      await execute(Prisma.sql`UPDATE ${table(RESOURCE_SUBSCRIPTIONS)} SET ${column(RESOURCE_SUBSCRIPTIONS, "deleted_at")} = ${now}, ${column(RESOURCE_SUBSCRIPTIONS, "updated_at")} = ${now} WHERE ${column(RESOURCE_SUBSCRIPTIONS, "id")} = ${found.id}`);
      return successWithObject("resource_subscription", null);
    },
  },
);
