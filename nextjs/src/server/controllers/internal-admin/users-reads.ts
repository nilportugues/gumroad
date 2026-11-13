// Api::Internal::Admin::UsersController: #affiliates, #compliance_info and #unpaid_balance, the reads over rows the user owns.
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { isBlank as rubyBlank } from "../../models/compliance-countries.ts";
import { selectRows } from "../../models/sql.ts";
import { isStrongboxBlank } from "../../models/strongbox.ts";
import {
  aliveUserComplianceInfoRow,
  businessCountryCode,
  countryCode,
  decryptedTaxId,
  isBusiness,
  jsonAttr,
  legalEntityName,
} from "../../models/user-compliance-info.ts";
import { NotPortedError } from "../../models/user.ts";

import { failure, jsonRendered, paramToS, timeJson } from "./base.ts";
import { paginateWithCursor } from "./cursor.ts";
import { defineAdminRoute } from "./registry.ts";
import { findUserForRead, successPayload } from "./users.ts";

const SOURCE = "app/controllers/api/internal/admin/users_controller.rb";
const AFFILIATE_DIRECTIONS = ["granted", "received"];
const AFFILIATE_TYPES = ["DirectAffiliate", "Collaborator"];
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;
const TAX_ID_VISIBLE_CHARACTERS = 4;
const TERMINAL_REFUND_STATUSES = ["failed", "canceled"];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

type AffiliateRow = {
  id: number;
  type: string;
  seller_id: number | null;
  affiliate_user_id: number | null;
  affiliate_basis_points: number | null;
  destination_url: string | null;
  flags: number;
  deleted_at: Date | null;
  created_at: Date;
  created_at_iso: string;
};

type CounterpartyUser = {
  id: bigint;
  external_id: string | null;
  email: string | null;
  unconfirmed_email: string | null;
  name: string | null;
  username: string | null;
};

const presence = (value: string | null): string | null => (value === null || rubyBlank(value) ? null : value);

// User#display_name(prefer_email_over_default_username: true); `username` falls back to the external id when none is stored.
export function counterparty(user: CounterpartyUser | undefined) {
  if (user === undefined) return null;
  const formEmail = presence(user.unconfirmed_email) ?? presence(user.email);
  const username = presence(user.username) ?? user.external_id;
  const displayName =
    presence(user.name) ??
    (username === user.external_id ? (formEmail ?? presence(username)) : (presence(username) ?? formEmail));
  return { id: user.external_id, email: user.email, name: displayName };
}

// Compliance::Countries.find_subdivision_code reads the countries gem's subdivision tables, which Node does not carry. Only the
// recorded outcomes are served: California in the US is CA, and in any other country no subdivision carries that name.
function subdivisionCode(state: string, code: string | null): string | null {
  if (state.toLowerCase() !== "california") throw new NotPortedError("a compliance address with a state", SOURCE);
  if (code === "US") return "CA";
  if (code === null || code === "MX" || code === "CA")
    throw new NotPortedError("a compliance address with a state", SOURCE);
  return null;
}

export function addressOf(
  street: string | null,
  city: string | null,
  state: string | null,
  zip: string | null,
  country: string | null,
  code: string | null,
) {
  const stateCode = state === null ? null : state === "" ? null : subdivisionCode(state, code);
  return { street_address: street, city, state, state_code: stateCode, zip_code: zip, country, country_code: code };
}

// `decrypt(...).to_s[-4..]`: unlike the settings page, whitespace stays, and fewer than four characters is nil.
export function taxIdLastFour(ciphertext: Uint8Array | null): string | null {
  if (isStrongboxBlank(ciphertext)) return null;
  const characters = Array.from(decryptedTaxId(ciphertext));
  return characters.length < TAX_ID_VISIBLE_CHARACTERS ? null : characters.slice(-TAX_ID_VISIBLE_CHARACTERS).join("");
}

// UserComplianceInfoRequest#last_email_sent_at: the last of the stored emails_sent_at times.
export function lastEmailSentAt(jsonData: string | null): string | null {
  if (jsonData === null || rubyBlank(jsonData)) return null;
  const sent = (JSON.parse(jsonData) as Record<string, unknown>).emails_sent_at;
  if (sent === undefined || sent === null || (Array.isArray(sent) && sent.length === 0)) return null;
  const last: unknown = Array.isArray(sent) ? sent.at(-1) : undefined;
  if (typeof last !== "string" || !ISO_TIME.test(last))
    throw new NotPortedError("an emails_sent_at entry that is not an ISO 8601 string", SOURCE);
  return timeJson(new Date(last));
}

// RefundUnpaidPurchasesWorker.unpaid_balance_summary_for: what is still refundable on purchases credited to an unpaid balance.
export async function unpaidBalanceSummary(userId: bigint): Promise<{ count: number; total: number }> {
  const rows = await selectRows<{ refundable: Prisma.Decimal | number | bigint }>(Prisma.sql`
    SELECT COALESCE(purchases.price_cents, 0) + COALESCE(purchases.gumroad_tax_cents, 0) - COALESCE(SUM(refunds.amount_cents), 0) - COALESCE(SUM(refunds.gumroad_tax_cents), 0) AS refundable
    FROM purchases
    LEFT OUTER JOIN refunds ON refunds.purchase_id = purchases.id AND (refunds.status IS NULL OR refunds.status NOT IN (${Prisma.join(TERMINAL_REFUND_STATUSES)}) OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')
    WHERE purchases.seller_id = ${userId}
      AND purchases.purchase_success_balance_id IN (SELECT id FROM balances WHERE user_id = ${userId} AND state = 'unpaid')
      AND purchases.purchase_state = 'successful'
      AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)
    GROUP BY purchases.id, purchases.price_cents, purchases.gumroad_tax_cents`);
  return { count: rows.length, total: rows.reduce((sum, row) => sum + Number(row.refundable), 0) };
}

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/users/affiliates",
    run: async (admin) => {
      const direction = paramToS(admin.params.direction, SOURCE);
      if (!AFFILIATE_DIRECTIONS.includes(direction)) return failure("direction must be 'granted' or 'received'", 400);
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const granted = direction === "granted";
      const owner = Prisma.raw(granted ? "`affiliates`.`seller_id`" : "`affiliates`.`affiliate_user_id`");
      const page = await paginateWithCursor<AffiliateRow>(
        "affiliates",
        Prisma.sql`${owner} = ${user.id} AND \`affiliates\`.\`type\` IN (${Prisma.join(AFFILIATE_TYPES)})`,
        admin.params,
        Prisma.raw(
          "`affiliates`.`id`, `affiliates`.`type`, `affiliates`.`seller_id`, `affiliates`.`affiliate_user_id`, `affiliates`.`affiliate_basis_points`, `affiliates`.`destination_url`, `affiliates`.`flags`, `affiliates`.`deleted_at`, `affiliates`.`created_at`",
        ),
      );
      if ("invalid" in page) return page.invalid;

      const counterpartyOf = (row: AffiliateRow) => (granted ? row.affiliate_user_id : row.seller_id);
      const counterpartyIds = [...new Set(page.rows.map(counterpartyOf).filter((id): id is number => id !== null))];
      const users =
        counterpartyIds.length === 0
          ? []
          : await db.user.findMany({
              where: { id: { in: counterpartyIds.map(BigInt) } },
              select: { id: true, external_id: true, email: true, unconfirmed_email: true, name: true, username: true },
            });
      const usersById = new Map(users.map((row) => [Number(row.id), row]));
      const links =
        page.rows.length === 0
          ? []
          : await db.productAffiliate.findMany({
              where: { affiliate_id: { in: page.rows.map((row) => row.id) } },
              orderBy: { id: "asc" },
            });
      const productIds = [...new Set(links.map((link) => link.link_id).filter((id): id is number => id !== null))];
      const products =
        productIds.length === 0
          ? []
          : await db.link.findMany({ where: { id: { in: productIds.map(BigInt) } }, select: { id: true, name: true } });
      const productsById = new Map(products.map((product) => [Number(product.id), product]));

      const affiliates = page.rows.map((row) => ({
        id: encrypt(row.id),
        type: row.type,
        direction,
        counterparty: counterparty(usersById.get(counterpartyOf(row) ?? -1)),
        affiliate_basis_points: row.affiliate_basis_points,
        destination_url: row.destination_url,
        apply_to_all_products: (row.flags & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0,
        alive: row.deleted_at === null,
        deleted_at: timeJson(row.deleted_at),
        created_at: timeJson(row.created_at),
        products: links
          .filter((link) => link.affiliate_id === row.id)
          .map((link) => {
            const product = link.link_id === null ? undefined : productsById.get(link.link_id);
            return {
              id: product === undefined ? null : encrypt(product.id),
              name: product?.name ?? null,
              basis_points: link.affiliate_basis_points ?? row.affiliate_basis_points,
              destination_url: link.destination_url,
            };
          }),
      }));
      return jsonRendered(successPayload(user, { direction, affiliates, pagination: page.pagination }));
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/users/compliance_info",
    run: async (admin) => {
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const row = await aliveUserComplianceInfoRow(user.id);
      const business = row !== null && isBusiness(row);
      const complianceInfo =
        row === null
          ? null
          : {
              id: encrypt(row.id),
              is_business: business,
              legal_name: presence(legalEntityName(row)),
              first_name: row.first_name,
              last_name: row.last_name,
              dba: row.dba,
              birthday: row.birthday === null ? null : row.birthday.toISOString().slice(0, 10),
              nationality: jsonAttr(row, "nationality"),
              phone: jsonAttr(row, "phone"),
              job_title: jsonAttr(row, "job_title"),
              address: addressOf(row.street_address, row.city, row.state, row.zip_code, row.country, countryCode(row)),
              business_name: row.business_name,
              business_type: row.business_type,
              business_phone: jsonAttr(row, "business_phone"),
              business_vat_id_number: jsonAttr(row, "business_vat_id_number"),
              business_address: business
                ? addressOf(
                    row.business_street_address,
                    row.business_city,
                    row.business_state,
                    row.business_zip_code,
                    row.business_country,
                    businessCountryCode(row),
                  )
                : null,
              tax_ids: {
                individual_last_four: taxIdLastFour(row.individual_tax_id),
                business_last_four: taxIdLastFour(row.business_tax_id),
              },
              identity_documents: {
                stripe_identity_document_id: row.stripe_identity_document_id,
                stripe_company_document_id: jsonAttr(row, "stripe_company_document_id"),
                stripe_additional_document_id: jsonAttr(row, "stripe_additional_document_id"),
              },
              created_at: timeJson(row.created_at),
              updated_at: timeJson(row.updated_at),
            };
      const requests = await db.$queryRaw<
        {
          id: number;
          field_needed: string | null;
          state: string | null;
          due_at: Date | null;
          created_at: Date;
          json_data: string | null;
        }[]
      >`SELECT id, field_needed, state, due_at, created_at, json_data FROM user_compliance_info_requests WHERE user_id = ${user.id} AND state = 'requested' ORDER BY ISNULL(due_at), due_at ASC, created_at ASC`;
      const now = Date.now();
      const infoRequests = requests.map((request) => ({
        id: encrypt(request.id),
        field_needed: request.field_needed,
        state: request.state,
        due_at: timeJson(request.due_at),
        overdue: request.due_at !== null && request.due_at.getTime() < now,
        created_at: timeJson(request.created_at),
        last_email_sent_at: lastEmailSentAt(request.json_data),
      }));
      return jsonRendered(successPayload(user, { compliance_info: complianceInfo, info_requests: infoRequests }));
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/users/unpaid_balance",
    run: async (admin) => {
      const found = await findUserForRead(admin, false);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const { count, total } = await unpaidBalanceSummary(user.id);
      return jsonRendered(successPayload(user, { count, total, total_amount_cents: total, currency: "usd" }));
    },
  },
);
