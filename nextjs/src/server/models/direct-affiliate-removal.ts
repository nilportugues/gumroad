// The soft delete of a DirectAffiliate (app/models/direct_affiliate.rb, Affiliate, Deletable and Affiliate::AudienceMember), as
// `AffiliatesController#destroy` runs it: `mark_deleted!`, which saves with validations, so a row that no longer validates raises.
//
// Not ported, and refused before the write by `removalBlocker`: a fee outside 1%..75% or a destination URL (their validators are not
// modelled), a seller with no username when the affiliate has several products and no destination URL, a row that is already deleted
// (a second `mark_deleted!` would move `deleted_at` and mail again), and an audience member that stays valid after the affiliate's
// entries leave it (a customer, follower or another affiliate: the recomputed columns are not pinned by a recording).
import { Prisma, type Affiliate } from "@prisma/client";

import { AudienceMembers, findAudienceMember, type Details } from "./audience-member-record.ts";
import { deletable } from "./concerns/deletable.ts";
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
    if (record.get("deleted_at") === null)
      throw new NotPortedError(
        "Restoring an affiliate or changing its flags",
        "app/models/concerns/affiliate/audience_member.rb",
      );
    await removeFromAudienceMemberDetails(record);
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
  if (affiliate.deleted_at !== null) return "an affiliate that is already deleted";
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
