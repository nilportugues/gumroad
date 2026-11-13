// Api::V2::Partner::BaseController's guards and Api::V2::Partner::CategoriesController. A partner calls with a client-credentials token
// (no resource owner) of an application flagged `is_partner` and confidential. `products` and `creators/top` search Elasticsearch and
// stay in Rails.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../../models/sql.ts";

import { json, present, registerApiV2, type ApiV2Input } from "./base.ts";
import { categoriesForApi } from "./categories.ts";

const PARTNER_SCOPE = "partner_api";
const CACHE_SECONDS = 3600;
// Api::V2::Partner::BaseController::SORT_KEYS
const SORT_KEYS = ["best_sellers", "newest", "hot_and_new", "highest_rated", "most_reviewed"];

const forbidden = () =>
  json({ success: false, message: "This endpoint is only available to partner applications." }, 403);

// before_action :require_partner_application!, then :require_supported_sort!
async function guards({ token, params }: ApiV2Input) {
  if (token.resource_owner_id !== null) return forbidden();
  const [application] = await selectRows<{ is_partner: unknown; confidential: unknown }>(
    Prisma.sql`SELECT ${column("oauth_applications", "is_partner")}, ${column("oauth_applications", "confidential")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} = ${token.application_id} AND ${column("oauth_applications", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (application === undefined || Number(application.is_partner) === 0 || Number(application.confidential) === 0)
    return forbidden();
  if (present(params.sort) && (typeof params.sort !== "string" || !SORT_KEYS.includes(params.sort)))
    return json({ success: false, message: `Unsupported sort. Use one of: ${SORT_KEYS.join(", ")}.` }, 400);
  return undefined;
}

registerApiV2({
  method: "GET",
  pattern: "/v2/partner/categories",
  scopes: [PARTNER_SCOPE],
  requireScope: [PARTNER_SCOPE],
  ownerless: true,
  before: guards,
  async run() {
    return json({ success: true, categories: await categoriesForApi() }, 200, {
      "cache-control": `max-age=${CACHE_SECONDS}, private`,
    });
  },
});
