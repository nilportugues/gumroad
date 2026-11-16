// Port of app/models/team_invitation.rb: the validations, the `accepted_at`/`deleted_at` state fields and the lookups the team
// invitation actions make.
import { Prisma, type TeamInvitation } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { belongsToRequired, loadBelongsTo, validatesUniqueness, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesInclusionOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { isValidEmailFormat, NotPortedError, strippedField } from "./user.ts";

const paperTrail = hasPaperTrail<TeamInvitation>("TeamInvitation", { itemType: "TeamInvitation" });

// TeamInvitation::ROLES: TeamMembership::ROLES without the owner.
export const TEAM_INVITATION_ROLES = ["accountant", "admin", "marketing", "support"] as const;
export const ACTIVE_INTERVAL_IN_DAYS = 7;

const TABLE = "team_invitations";
const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };

type Invitation = ModelRecord<TeamInvitation>;
const notDeleted = (record: Invitation) => record.get("deleted_at") == null;

// A bare dot-atom mailbox, the shape Mail::AddressList parses to exactly one address equal to the input. Anything else that passes
// EMAIL_REGEX (quoted local parts, IP literals, punctuation Mail treats specially) needs the Mail gem's parser.
const PLAIN_MAILBOX = /^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*@([a-z0-9-]+\.)+[a-z]{2,}$/iu;

// `single_mailbox_email?`
export function singleMailboxEmail(email: string): boolean {
  if (!isValidEmailFormat(email)) return false;
  if (PLAIN_MAILBOX.test(email)) return true;
  throw new NotPortedError("Parsing a team invitation email as a mailbox", "TeamInvitation#single_mailbox_email?");
}

const emailFormat: Callback<TeamInvitation> = {
  name: "validates :email, email_format",
  run(record) {
    if (!isValidEmailFormat(record.get("email"))) record.errors.add("email", "invalid");
  },
};

const emailIsSingleMailbox: Callback<TeamInvitation> = {
  name: "email_is_single_mailbox",
  if: notDeleted,
  run(record) {
    if (record.errors.on("email").length === 0 && !singleMailboxEmail(record.get("email")))
      record.errors.add("email", "invalid");
  },
};

// `seller.seller_memberships.not_deleted.joins(:user).where("users.email = ?", email).none? && email != seller.email`
const emailCannotBelongToExistingMember: Callback<TeamInvitation> = {
  name: "email_cannot_belong_to_existing_member",
  if: notDeleted,
  async run(record, ctx) {
    const seller = await loadBelongsTo(record, SELLER, ctx);
    if (seller === null) return;
    const email = record.get("email");
    const members = await ctx.tx.$queryRaw<unknown[]>(
      Prisma.sql`SELECT 1 AS one FROM ${table("team_memberships")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("team_memberships", "user_id")} WHERE ${column("team_memberships", "seller_id")} = ${seller.id} AND ${column("team_memberships", "deleted_at")} IS NULL AND ${column("users", "email")} = ${email} LIMIT 1`,
    );
    if (members.length === 0 && email !== seller.email) return;
    record.errors.add("email", "is associated with an existing team member");
  },
};

export const TeamInvitations = defineModel<TeamInvitation>({
  rubyClass: "TeamInvitation",
  prismaModel: "TeamInvitation",
  delegate: (tx) => tx.teamInvitation as never,
  beforeValidation: [
    {
      // stripped_fields :email, transform: -> { _1.downcase }
      name: "stripped_fields :email",
      run(record) {
        const stripped = strippedField(record.get("email"));
        record.set("email", (stripped === null ? null : stripped.toLowerCase())!);
      },
    },
  ],
  validations: [
    belongsToRequired<TeamInvitation>(SELLER),
    emailFormat,
    emailIsSingleMailbox,
    {
      ...validatesUniqueness<TeamInvitation>("TeamInvitation", TABLE, "email", {
        scope: ["seller_id", "deleted_at"],
        message: "has already been invited",
      }),
      if: notDeleted,
    },
    emailCannotBelongToExistingMember,
    validatesInclusionOf<TeamInvitation>(["role"], { in: TEAM_INVITATION_ROLES }),
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  beforeDestroy: [...paperTrail.beforeDestroy],
});

// `timestamp_state_fields :accepted, :deleted`
export const TeamInvitationDeletable = deletable(TeamInvitations);

export const isExpired = (record: Invitation, now: Date = new Date()) => record.get("expires_at") < now;
export const isAccepted = (record: Invitation) => record.get("accepted_at") != null;
export const isDeleted = (record: Invitation) => record.get("deleted_at") != null;
// `email.downcase == seller.email&.downcase`
export const matchesOwnerEmail = (record: Invitation, sellerEmail: string | null) =>
  record.get("email").toLowerCase() === (sellerEmail?.toLowerCase() ?? null);

// `current_seller.team_invitations.find_by_external_id(id)`: the seller's own invitation, deleted or not.
export async function sellerInvitationById(sellerId: bigint | number, id: bigint | number): Promise<Invitation | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`team_invitations`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "seller_id")} = ${sellerId} AND ${column(TABLE, "id")} = ${id} LIMIT 1`,
  );
  return row ? TeamInvitations.load(castRow<TeamInvitation>("TeamInvitation", row)) : null;
}

// `TeamInvitation.find_by_external_id!(id)`
export async function invitationById(id: bigint | number): Promise<Invitation | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`team_invitations`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "id")} = ${id} LIMIT 1`,
  );
  return row ? TeamInvitations.load(castRow<TeamInvitation>("TeamInvitation", row)) : null;
}
