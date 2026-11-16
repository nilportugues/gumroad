// The soft delete of a DirectAffiliate (app/models/direct_affiliate.rb, Affiliate, Deletable and Affiliate::AudienceMember), as
// `AffiliatesController#destroy` runs it: `mark_deleted!`, which saves with validations, so a row that no longer validates raises.
//
// Not ported, and refused before the write by `removalBlocker`: a destination URL (its validator is not modelled), a seller with no
// username when the affiliate has several products and no destination URL, and an audience member that stays valid after the
// affiliate's entries leave it (a customer, follower or another affiliate: the recomputed columns are not pinned by a recording).
// A row that is already deleted goes through again: `mark_deleted!` moves `deleted_at` and mails again. A fee outside 1%..75% is the
// controller's 422, answered before this runs.
import { Prisma, type Affiliate } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { AudienceMembers, findAudienceMember, type Details } from "./audience-member-record.ts";
import { deletable } from "./concerns/deletable.ts";
import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export type AffiliateRecord = ModelRecord<Affiliate>;

export const DIRECT_AFFILIATE = "DirectAffiliate";
// Affiliate::BasisPointsValidations
const MIN_AFFILIATE_BASIS_POINTS = 100;
const MAX_AFFILIATE_BASIS_POINTS = 7500;

const affiliateUser = {
  name: "affiliate_user",
  foreignKey: "affiliate_user_id",
  targetTable: "users",
  targetModel: "User",
} as const;
const seller = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" } as const;

async function emailOf(userId: number): Promise<string | null> {
  const [row] = await selectRows<{ email: string | null }>(
    Prisma.sql`SELECT ${column("users", "email")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`,
  );
  return row?.email ?? null;
}

// Details of an audience member without this affiliate's entries: `details["affiliates"]&.delete_if { _1["id"] == id }`.
function withoutAffiliate(details: Details, affiliateId: number): Details {
  const rest = { ...details };
  if (Array.isArray(rest.affiliates))
    rest.affiliates = rest.affiliates.filter((entry) => (entry as { id?: unknown }).id !== affiliateId);
  return rest;
}

// Affiliate::AudienceMember#remove_from_audience_member_details
async function removeFromAudienceMemberDetails(record: AffiliateRecord): Promise<void> {
  if (record.get("type") !== DIRECT_AFFILIATE) return;
  const email = await emailOf(record.get("affiliate_user_id")!);
  const member = email === null ? null : await findAudienceMember(email, BigInt(record.get("seller_id")!));
  if (member === null) return;
  member.set("details", withoutAffiliate((member.get("details") ?? {}) as Details, record.get("id")) as never);
  // `member.valid? ? member.save! : member.destroy!`
  if (await AudienceMembers.valid(member))
    throw new NotPortedError(
      "An audience member who is still a customer, follower or affiliate",
      "app/models/concerns/affiliate/audience_member.rb",
    );
  await AudienceMembers.destroyBang(member);
}

// Affiliate::AudienceMember#update_audience_member_details: only the branch a deletion takes.
const updateAudienceMemberDetails: Callback<Affiliate> = {
  name: "update_audience_member_details",
  async run(record) {
    if (record.get("type") !== DIRECT_AFFILIATE) return;
    if (!record.savedChanges.deleted_at && !record.savedChanges.flags) return;
    // A new affiliate who gets posts: `should_be_audience_member?` holds and `deleted_at` did not change, so the callback ends there
    // (its product assignments add the audience member).
    if (
      record.get("deleted_at") === null &&
      !record.savedChanges.deleted_at &&
      (record.get("flags") & SEND_POSTS_FLAG) !== 0 &&
      record.savedChanges.created_at !== undefined
    )
      return;
    if (record.get("deleted_at") === null)
      throw new NotPortedError(
        "Restoring an affiliate or changing its flags",
        "app/models/concerns/affiliate/audience_member.rb",
      );
    await removeFromAudienceMemberDetails(record);
  },
};

const SEND_POSTS_FLAG = 2;
const AFFILIATE_MAILER = "AffiliateMailer";
const INVITATION_MAIL = "direct_affiliate_invitation";
const INVITATION_DELAY_SECONDS = 3;

// `after_commit :send_invitation_email, on: :create`, unless `prevent_sending_invitation_email` is set.
const sendInvitationEmail: Callback<Affiliate> = {
  name: "send_invitation_email",
  on: "create",
  unless: (record) => record.ivars.preventSendingInvitationEmail === true,
  async run(record) {
    // `prevent_sending_invitation_email_to_seller` is not set by the controller: nil.
    await deliverLater(
      currentJobsRuntime(),
      {
        mailer: AFFILIATE_MAILER,
        method: INVITATION_MAIL,
        args: [record.get("id"), null],
        waitSeconds: INVITATION_DELAY_SECONDS,
      },
      mailRoute(AFFILIATE_MAILER, INVITATION_MAIL),
    );
  },
};

export const DirectAffiliates = defineModel<Affiliate>({
  rubyClass: DIRECT_AFFILIATE,
  prismaModel: "Affiliate",
  delegate: (tx) => tx.affiliate as never,
  validations: [
    validatesAssociationPresence<Affiliate>(affiliateUser),
    validatesAssociationPresence<Affiliate>(seller),
  ],
  afterSave: [updateAudienceMemberDetails],
  afterCommit: [sendInvitationEmail],
});

const softDeletion = deletable(DirectAffiliates);

export const loadAffiliate = (row: Record<string, unknown>): AffiliateRecord =>
  DirectAffiliates.load(castRow<Affiliate>("Affiliate", row));
export const markDeletedBang = (record: AffiliateRecord) => softDeletion.markDeletedBang(record);

export type AffiliateRemovalRow = Pick<
  Affiliate,
  "id" | "seller_id" | "affiliate_user_id" | "affiliate_basis_points" | "destination_url" | "deleted_at"
>;

// Why the removal cannot be answered here, or null. Reads only: nothing has been written.
export async function removalBlocker(affiliate: AffiliateRemovalRow): Promise<string | null> {
  const points = affiliate.affiliate_basis_points;
  if (points === null || points < MIN_AFFILIATE_BASIS_POINTS || points > MAX_AFFILIATE_BASIS_POINTS)
    return "an affiliate whose fee is outside the allowed range, which fails validation";
  if (affiliate.destination_url !== null && affiliate.destination_url !== "")
    return "an affiliate with a destination URL, whose format is validated";
  if (affiliate.seller_id === null || affiliate.affiliate_user_id === null)
    return "an affiliate without a seller or an account";

  const [sellerRow] = await selectRows<{ username: string | null }>(
    Prisma.sql`SELECT ${column("users", "username")} FROM ${table("users")} WHERE ${column("users", "id")} = ${affiliate.seller_id} LIMIT 1`,
  );
  if (sellerRow === undefined) return "an affiliate whose seller is missing";
  if (sellerRow.username === null || sellerRow.username === "")
    return "a seller without a username, whose products decide validation";

  const email = await emailOf(affiliate.affiliate_user_id);
  if (email === null) return "an affiliate whose account is missing";
  const member = await findAudienceMember(email, BigInt(affiliate.seller_id));
  if (member !== null) {
    member.set("details", withoutAffiliate((member.get("details") ?? {}) as Details, affiliate.id) as never);
    if (await AudienceMembers.valid(member)) return "an audience member who is still a customer, follower or affiliate";
  }
  return null;
}
