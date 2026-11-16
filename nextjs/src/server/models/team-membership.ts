// Port of app/models/team_membership.rb: the validations, the `deleted_at` state field and the writes controllers make
// (switching account, and the team settings page's role change, removal and restore).
import { Prisma, type TeamMembership } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { deletable } from "./concerns/deletable.ts";
import { loadBelongsTo, validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesInclusionOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const paperTrail = hasPaperTrail<TeamMembership>("TeamMembership", { itemType: "TeamMembership" });

export const TEAM_MEMBERSHIP_ROLES = ["owner", "accountant", "admin", "marketing", "support"] as const;

const TABLE = "team_memberships";
const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };

const isOwner = (record: ModelRecord<TeamMembership>) => record.get("role") === "owner";
const notDeleted = (record: ModelRecord<TeamMembership>) => record.get("deleted_at") == null;

// `validates_uniqueness_of :seller, scope: %i[user deleted_at], if: :not_deleted?`: the lookup runs on the foreign keys, the error
// lands on the association. No unique index covers the three columns, so the query is never skipped.
const sellerUniquePerUser: Callback<TeamMembership> = {
  name: "validates_uniqueness_of seller",
  if: notDeleted,
  async run(record, ctx) {
    const where = [Prisma.sql`${column(TABLE, "seller_id")} = ${record.get("seller_id")}`, Prisma.sql`${column(TABLE, "user_id")} = ${record.get("user_id")}`, Prisma.sql`${column(TABLE, "deleted_at")} IS NULL`];
    if (record.persisted) where.push(Prisma.sql`${column(TABLE, "id")} != ${record.get("id")}`);
    const rows = await ctx.tx.$queryRaw<unknown[]>(Prisma.sql`SELECT 1 AS one FROM ${table(TABLE)} WHERE ${Prisma.join(where, " AND ")} LIMIT 1`);
    if (rows.length > 0) record.errors.add("seller", "taken", { value: record.get("seller_id") });
  },
};

// `user != seller` compares the loaded records, so two missing ones are equal.
async function sameUserAndSeller(record: ModelRecord<TeamMembership>, ctx: Parameters<Callback<TeamMembership>["run"]>[1]): Promise<boolean> {
  const user = await loadBelongsTo(record, USER, ctx);
  const seller = await loadBelongsTo(record, SELLER, ctx);
  return (user?.id ?? null) === (seller?.id ?? null);
}

const ownerRoleOnlyForOwnMembership: Callback<TeamMembership> = {
  name: "owner_role_cannot_be_assigned_to_other_users",
  async run(record, ctx) {
    if (!isOwner(record)) return;
    if (await sameUserAndSeller(record, ctx)) return;
    record.errors.add("seller_id", "must match user for owner role");
  },
};

const ownRoleMustBeOwner: Callback<TeamMembership> = {
  name: "only_owner_role_can_be_assigned_to_natural_owner",
  async run(record, ctx) {
    if (!(await sameUserAndSeller(record, ctx))) return;
    if (isOwner(record)) return;
    record.errors.add("role", "cannot be assigned to owner's membership");
  },
};

// `user && user.user_memberships.one?(&:role_owner?)`: exactly one owner membership, deleted or not.
const ownerMembershipMustExist: Callback<TeamMembership> = {
  name: "owner_membership_must_exist",
  async run(record, ctx) {
    if (isOwner(record)) return;
    if ((await loadBelongsTo(record, USER, ctx)) !== null) {
      const rows = await ctx.tx.$queryRaw<{ role: string }[]>(Prisma.sql`SELECT ${Prisma.raw("`team_memberships`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "user_id")} = ${record.get("user_id")}`);
      if (rows.filter((row) => row.role === "owner").length === 1) return;
    }
    record.errors.add("user_id", "requires owner membership to be created first");
  },
};

export const TeamMemberships = defineModel<TeamMembership>({
  rubyClass: "TeamMembership",
  prismaModel: "TeamMembership",
  delegate: (tx) => tx.teamMembership as never,
  validations: [
    validatesAssociationPresence<TeamMembership>(USER),
    validatesAssociationPresence<TeamMembership>(SELLER),
    validatesInclusionOf<TeamMembership>(["role"], { in: TEAM_MEMBERSHIP_ROLES }),
    sellerUniquePerUser,
    ownerMembershipMustExist,
    ownerRoleOnlyForOwnMembership,
    ownRoleMustBeOwner,
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});

// `timestamp_state_fields :deleted`: update_as_deleted! and update_as_not_deleted!.
export const TeamMembershipDeletable = deletable(TeamMemberships);

// `current_seller.seller_memberships.find_by_external_id(id)`: the row is the seller's own, deleted or not.
export async function sellerMembershipById(sellerId: bigint | number, id: bigint | number): Promise<ModelRecord<TeamMembership> | null> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`team_memberships`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "seller_id")} = ${sellerId} AND ${column(TABLE, "id")} = ${id} LIMIT 1`);
  return row ? TeamMemberships.load(castRow<TeamMembership>("TeamMembership", row)) : null;
}
