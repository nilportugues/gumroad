// Api::V2::Partner::BaseController's guards and Api::V2::Partner::MigrationsController#show, the partner's poll of an import it started.
// `create` serves only the guards that run before the catalogue is validated; the rest stays in Rails: it normalises the catalogue,
// issues the one-time link and sends mail.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../../models/sql.ts";
import { escapeHtmlInJson } from "../../search/es-json.ts";
import { HandBackToRails } from "../application-controller.ts";

import { json, present, registerApiV2, type ApiV2Input } from "./base.ts";

const PARTNER_SCOPE = "partner_api";
// PartnerMigration::MAX_EXTERNAL_USER_ID_LENGTH
const MAX_EXTERNAL_USER_ID_LENGTH = 255;
// Api::V2::Partner::BaseController::SORT_KEYS
const SORT_KEYS = ["best_sellers", "newest", "hot_and_new", "highest_rated", "most_reviewed"];
// PartnerMigration::PUBLIC_ID_FORMAT
const PUBLIC_ID_FORMAT = /^[A-Za-z0-9_-]{21}$/u;
// The job records a result under the position of the product in the catalogue.
const POSITION_KEY = /^(?:0|[1-9]\d*)$/u;

type MigrationRow = {
  oauth_application_id: unknown;
  status: string;
  failure_reason: string | null;
  products: string;
  results: string | null;
};

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A number Ruby and JavaScript would not print the same way.
function hasUnsafeNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasUnsafeNumber);
  return isObject(value) && Object.values(value).some(hasUnsafeNumber);
}

// PartnerMigration#progress and #results_by_external_product_id. The keys of the second are the partner's own product ids, which may
// look like integers, so the body is written by hand: an object literal would sort them.
function showBody(row: MigrationRow): string {
  const products: unknown = JSON.parse(row.products);
  const results: unknown = row.results === null ? {} : JSON.parse(row.results);
  if (!Array.isArray(products) || !isObject(results) || hasUnsafeNumber(results))
    throw new HandBackToRails("a migration that does not parse");
  const positions = Object.keys(results);
  const values = Object.values(results);
  if (!positions.every((key) => POSITION_KEY.test(key)) || !values.every(isObject))
    throw new HandBackToRails("a result with an odd shape");

  const imported = values.filter((result) => present(result.product_id)).length;
  const failed = values.filter((result) => present(result.error)).length;
  const byExternalId = new Map<string, string>();
  for (const [position, result] of Object.entries(results)) {
    const product: unknown = products[Number(position)];
    if (!isObject(product) || typeof product.external_product_id !== "string")
      throw new HandBackToRails("a result without its product");
    byExternalId.set(product.external_product_id, JSON.stringify(result));
  }
  const resultsJson = `{${[...byExternalId].map(([id, result]) => `${JSON.stringify(id)}:${result}`).join(",")}}`;
  return `{"success":true,"status":${JSON.stringify(row.status)},"total":${products.length},"imported":${imported},"failed":${failed},"remaining":${products.length - imported - failed},"results":${resultsJson},"failure_reason":${JSON.stringify(row.failure_reason)}}`;
}

registerApiV2({
  method: "GET",
  pattern: "/v2/partner/migrations/:id",
  scopes: [PARTNER_SCOPE],
  requireScope: [PARTNER_SCOPE],
  ownerless: true,
  before: guards,
  async run({ token, routeParams }) {
    const id = routeParams.id ?? "";
    const notFound = { status: 404, body: "", contentType: "text/html" };
    if (!PUBLIC_ID_FORMAT.test(id)) return notFound;
    const [row] = await selectRows<MigrationRow>(
      Prisma.sql`SELECT oauth_application_id, status, failure_reason, CAST(products AS CHAR) AS products, CAST(results AS CHAR) AS results FROM ${table("partner_migrations")} WHERE ${column("partner_migrations", "public_id")} = ${id} LIMIT 1`,
    );
    if (row === undefined || Number(row.oauth_application_id) !== Number(token.application_id)) return notFound;
    return { status: 200, body: escapeHtmlInJson(showBody(row)), contentType: "application/json; charset=utf-8" };
  },
});

// MigrationsController#create up to normalize_products: whatever follows (the catalogue, seller, part checks and the writes) is Rails'.
registerApiV2({
  method: "POST",
  pattern: "/v2/partner/migrations",
  scopes: [PARTNER_SCOPE],
  requireScope: [PARTNER_SCOPE],
  ownerless: true,
  paramsReadBeforeScope: false,
  before: guards,
  run({ params }) {
    const externalUserId = params.external_user_id;
    if (
      typeof externalUserId !== "string" ||
      !present(externalUserId) ||
      Array.from(externalUserId).length > MAX_EXTERNAL_USER_ID_LENGTH
    )
      return json(
        {
          success: false,
          message: `external_user_id must be a string with 1 to ${MAX_EXTERNAL_USER_ID_LENGTH} characters, not only spaces.`,
        },
        400,
      );
    throw new HandBackToRails("a partner migration that passes the guards");
  },
});
