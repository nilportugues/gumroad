// Port of the validations of app/models/affiliate_request.rb, and its state predicates. Saving a request stays in Rails: its
// after_commit mails the requester and the seller, and a transition to approved makes the requester an affiliate.
import { Prisma, type AffiliateRequest } from "@prisma/client";

import { belongsToRequired, loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { validatesLengthOf, validatesPresenceOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { isValidEmailFormat } from "./user.ts";

export const ACTION_APPROVE = "approve";
export const ACTION_IGNORE = "ignore";
// User::MAX_LENGTH_NAME
const MAX_LENGTH_NAME = 100;

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };

const emailFormat: Callback<AffiliateRequest> = {
  name: "validates :email, email_format",
  run(record) {
    if (!isValidEmailFormat(record.get("email"))) record.errors.add("email", "invalid");
  },
};

// It's fine to ask again after the previous request was ignored.
const duplicateRequest: Callback<AffiliateRequest> = {
  name: "duplicate_request_validation",
  on: "create",
  async run(record, ctx) {
    const rows = await ctx.tx.$queryRaw<unknown[]>(
      Prisma.sql`SELECT 1 AS one FROM ${table("affiliate_requests")} WHERE ${column("affiliate_requests", "seller_id")} = ${record.get("seller_id")} AND ${column("affiliate_requests", "email")} = ${record.get("email")} AND ${column("affiliate_requests", "state")} IN ('created', 'approved') LIMIT 1`,
    );
    if (rows.length > 0)
      record.errors.add("base", "You have already requested to become an affiliate of this creator.");
  },
};

const requesterIsNotSeller: Callback<AffiliateRequest> = {
  name: "requester_is_not_seller",
  on: "create",
  async run(record, ctx) {
    const seller = await loadBelongsTo(record, SELLER, ctx);
    if (seller === null) return;
    if ((record.get("email")?.toLowerCase() ?? null) !== ((seller.email as string | null)?.toLowerCase() ?? null))
      return;
    record.errors.add("base", "You cannot request to become an affiliate of yourself.");
  },
};

export const AffiliateRequests = defineModel<AffiliateRequest>({
  rubyClass: "AffiliateRequest",
  prismaModel: "AffiliateRequest",
  delegate: (tx) => tx.affiliateRequest as never,
  validations: [
    belongsToRequired<AffiliateRequest>(SELLER),
    validatesPresenceOf<AffiliateRequest>(["name", "email", "promotion_text"]),
    validatesLengthOf<AffiliateRequest>(["name"], {
      maximum: MAX_LENGTH_NAME,
      too_long: "Your name is too long. Please try again with a shorter one.",
    }),
    emailFormat,
    duplicateRequest,
    requesterIsNotSeller,
  ],
});

// `current_seller.affiliate_requests.find_by_external_id`
export async function sellerRequestById(sellerId: bigint, id: bigint): Promise<AffiliateRequest | null> {
  const [row] = await selectRows<AffiliateRequest>(
    Prisma.sql`SELECT ${Prisma.raw("`affiliate_requests`.*")} FROM ${table("affiliate_requests")} WHERE ${column("affiliate_requests", "seller_id")} = ${sellerId} AND ${column("affiliate_requests", "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// `can_perform_action?`. The state column is NULL for a row inserted without the state machine's initial value.
export async function canPerformAction(
  request: Pick<AffiliateRequest, "state" | "email">,
  action: string,
): Promise<boolean> {
  if (action === ACTION_APPROVE) return request.state === "created";
  if (action !== ACTION_IGNORE) return true;
  // `allow_to_ignore?`: not already ignored, and not approved with a requester who has since signed up.
  if (request.state === "ignored") return false;
  if (request.state !== "approved") return true;
  const [user] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("users")} WHERE ${column("users", "email")} = ${request.email} LIMIT 1`,
  );
  return user === undefined;
}

// `seller.self_service_affiliate_products.enabled.exists?`
export async function hasEnabledSelfServiceProducts(sellerId: bigint): Promise<boolean> {
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("self_service_affiliate_products")} WHERE ${column("self_service_affiliate_products", "seller_id")} = ${sellerId} AND ${column("self_service_affiliate_products", "enabled")} = 1 LIMIT 1`,
  );
  return row !== undefined;
}

// `current_seller.affiliate_requests.unattended.exists?`
export async function hasUnattendedRequests(sellerId: bigint): Promise<boolean> {
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("affiliate_requests")} WHERE ${column("affiliate_requests", "seller_id")} = ${sellerId} AND ${column("affiliate_requests", "state")} = 'created' LIMIT 1`,
  );
  return row !== undefined;
}
