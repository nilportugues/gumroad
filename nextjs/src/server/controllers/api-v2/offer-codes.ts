// Api::V2::OfferCodesController reads (app/controllers/api/v2/offer_codes_controller.rb). The writes (create, update, destroy) run
// OfferCode's validations, cache invalidation and reindex callbacks, which are not ported: they stay in Rails.
import { Prisma, type Link, type OfferCode } from "@prisma/client";

import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { OfferCodeRecord } from "../../models/offer-code.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { type ApiV2Input, error400, errorWithObject, loadProduct, PUBLIC_READ_SCOPES, registerApiV2, successWithObject } from "./base.ts";
import { decodePageKey, paginationInfo, USEC_FORMAT } from "./pagination.ts";

const RESULTS_PER_PAGE = 10;
const OFFER_CODES = "offer_codes";
// The scopes of the actions that are not product scoped.
const STORE_SCOPES = ["view_sales", "edit_products"];
const iso8601 = (time: Date | null) => (time === null ? null : `${time.toISOString().slice(0, 19)}Z`);

// OfferCode#as_json_for_api
async function offerCodeJson(row: OfferCode) {
  const timesUsed = await new OfferCodeRecord(row).timesUsed();
  return {
    id: encrypt(row.id),
    name: row.code,
    max_purchase_count: row.max_purchase_count,
    minimum_amount_cents: row.minimum_amount_cents,
    universal: row.universal,
    auto_apply: row.auto_apply,
    sale_label: row.sale_label,
    valid_at: iso8601(row.valid_at),
    expires_at: iso8601(row.expires_at),
    currency_type: row.currency_type,
    times_used: timesUsed,
    ...(row.amount_percentage != null ? { percent_off: row.amount_percentage } : { amount_cents: row.amount_cents }),
  };
}

const selectOfferCodes = (where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty) =>
  selectRows<OfferCode & { created_usec: string }>(
    Prisma.sql`SELECT ${table(OFFER_CODES)}.*, DATE_FORMAT(${column(OFFER_CODES, "created_at")}, ${USEC_FORMAT}) AS created_usec FROM ${table(OFFER_CODES)} WHERE ${where}${tail}`,
  ).then((rows) => rows.map(({ created_usec, ...row }) => ({ ...castRow<OfferCode>("OfferCode", row), created_usec })));

const alive = Prisma.sql`${column(OFFER_CODES, "deleted_at")} IS NULL`;

// User#offer_codes.universal_with_matching_currency.alive; Link#universal_offer_codes adds not_excluding_product.
const universalMatchingCurrency = (userId: bigint, currency: string | null) =>
  Prisma.sql`${column(OFFER_CODES, "user_id")} = ${userId} AND universal = 1 AND (currency_type = ${currency} OR currency_type IS NULL) AND ${alive}`;

const universalCodes = (userId: bigint, currency: string | null, productId: bigint) =>
  Prisma.sql`${universalMatchingCurrency(userId, currency)} AND NOT EXISTS (SELECT 1 FROM offer_codes_excluded_products WHERE offer_codes_excluded_products.offer_code_id = offer_codes.id AND offer_codes_excluded_products.product_id = ${productId})`;

const productCodes = (productId: bigint) =>
  Prisma.sql`${column(OFFER_CODES, "id")} IN (SELECT offer_code_id FROM offer_codes_products WHERE product_id = ${productId}) AND ${alive}`;

// find_by_external_id: nil for an id that does not decrypt.
const idOf = (externalId: unknown): number | null => (typeof externalId === "string" ? decrypt(externalId) : null);

async function productIndex({ owner, state }: ApiV2Input) {
  const product: Link = state.product;
  // (product_codes + universal_codes).sort_by(&:created_at)
  const combined = [...(await selectOfferCodes(productCodes(product.id))), ...(await selectOfferCodes(universalCodes(owner.id, product.price_currency_type, product.id)))];
  combined.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  return successWithObject("offer_codes", await Promise.all(combined.map(offerCodeJson)));
}

async function storeIndex({ owner, params, request }: ApiV2Input) {
  const conditions = [Prisma.sql`${column(OFFER_CODES, "user_id")} = ${owner.id}`, alive];
  const { auto_apply: autoApply, page_key: pageKey } = params;
  if ("auto_apply" in params) {
    if (![true, false, "true", "false"].includes(autoApply as never)) return error400("auto_apply must be true or false.");
    conditions.push(Prisma.sql`${column(OFFER_CODES, "auto_apply")} = ${autoApply === true || autoApply === "true"}`);
  }
  if (pageKey !== undefined && pageKey !== null && pageKey !== "") {
    const decoded = typeof pageKey === "string" ? decodePageKey(pageKey) : null;
    if (decoded === null) return error400("Invalid page_key.");
    conditions.push(Prisma.sql`(${column(OFFER_CODES, "created_at")} < ${decoded.at} OR (${column(OFFER_CODES, "created_at")} = ${decoded.at} AND ${column(OFFER_CODES, "id")} < ${decoded.id}))`);
  }
  const page = await selectOfferCodes(Prisma.join(conditions, " AND "), Prisma.sql` ORDER BY ${column(OFFER_CODES, "created_at")} DESC, ${column(OFFER_CODES, "id")} DESC LIMIT ${RESULTS_PER_PAGE + 1}`);
  const additional = page.length > RESULTS_PER_PAGE ? paginationInfo(request, page[RESULTS_PER_PAGE - 1]!) : {};
  return successWithObject("offer_codes", await Promise.all(page.slice(0, RESULTS_PER_PAGE).map(offerCodeJson)), additional);
}

async function show({ owner, params, state }: ApiV2Input) {
  const product: Link | undefined = state.product;
  const id = idOf(params.id);
  let found: (OfferCode & { created_usec: string }) | undefined;
  if (id !== null) {
    const byId = Prisma.sql`${column(OFFER_CODES, "id")} = ${id}`;
    found =
      product === undefined
        ? (await selectOfferCodes(Prisma.sql`${column(OFFER_CODES, "user_id")} = ${owner.id} AND ${alive} AND ${byId} LIMIT 1`))[0]
        : ((await selectOfferCodes(Prisma.sql`${productCodes(product.id)} AND ${byId} LIMIT 1`))[0] ?? (await selectOfferCodes(Prisma.sql`${universalMatchingCurrency(owner.id, product.price_currency_type)} AND ${byId} LIMIT 1`))[0]);
  }
  return found === undefined ? errorWithObject("offer_code") : successWithObject("offer_code", await offerCodeJson(found));
}

registerApiV2(
  { method: "GET", pattern: "/v2/offer_codes", scopes: STORE_SCOPES, run: storeIndex },
  { method: "GET", pattern: "/v2/offer_codes/:id", scopes: STORE_SCOPES, run: show },
  { method: "GET", pattern: "/v2/products/:link_id/offer_codes", scopes: PUBLIC_READ_SCOPES, before: loadProduct("link_id"), run: productIndex },
  { method: "GET", pattern: "/v2/products/:link_id/offer_codes/:id", scopes: PUBLIC_READ_SCOPES, before: loadProduct("link_id"), run: show },
);
