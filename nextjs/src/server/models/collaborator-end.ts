// Ending a Collaborator (app/models/collaborator.rb, CollaboratorInvitation, Collaborators::BaseController#destroy): the soft delete,
// the collab flag cleared on each of its products, and the mail to the other side.
//
// Not ported, and refused before the write by `endBlocker`: a row that would fail validation (the commission range, a commission
// missing from an all-products collaboration, a missing seller or account), and a product whose own save would fail. Rails raises
// after the soft delete in those cases, which a recording cannot show without an error page.
import { Prisma, type Affiliate, type CollaboratorInvitation as InvitationRow, type Link } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { deletable } from "./concerns/deletable.ts";
import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { Links, LinkFlags } from "./link.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export const COLLABORATOR = "Collaborator";
// Collaborator::MIN_PERCENT_COMMISSION and MAX_PERCENT_COMMISSION, in basis points.
const MIN_BASIS_POINTS = 1 * 100;
const MAX_BASIS_POINTS = 50 * 100;
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;

const AFFILIATE_MAILER = "AffiliateMailer";
export const ENDED_BY_SELLER_MAIL = "collaboration_ended_by_seller";
export const ENDED_BY_AFFILIATE_USER_MAIL = "collaboration_ended_by_affiliate_user";
export const INVITATION_ACCEPTED_MAIL = "collaborator_invitation_accepted";
export const INVITATION_DECLINED_MAIL = "collaborator_invitation_declined";
export const INVITED_MAIL = "collaborator_invited";
export const CREATION_MAIL = "collaborator_creation";

export type CollaboratorRecord = ModelRecord<Affiliate>;

const affiliateUser = {
  name: "affiliate_user",
  foreignKey: "affiliate_user_id",
  targetTable: "users",
  targetModel: "User",
} as const;
const seller = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" } as const;

// The affiliate callbacks (Affiliate::AudienceMember) only act on a DirectAffiliate, so none of them runs for a Collaborator.
export const Collaborators = defineModel<Affiliate>({
  rubyClass: COLLABORATOR,
  prismaModel: "Affiliate",
  delegate: (tx) => tx.affiliate as never,
  validations: [
    validatesAssociationPresence<Affiliate>(affiliateUser),
    validatesAssociationPresence<Affiliate>(seller),
  ],
});

const collaboratorDeletion = deletable(Collaborators);

export type CollaboratorEndRow = Affiliate;

// `Collaborator.alive.find_by(id:)`
export async function loadAliveCollaborator(id: number): Promise<CollaboratorEndRow | undefined> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`affiliates`.*")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = ${COLLABORATOR} AND ${column("affiliates", "deleted_at")} IS NULL AND ${column("affiliates", "id")} = ${id} LIMIT 1`,
  );
  return row === undefined ? undefined : castRow<Affiliate>("Affiliate", row);
}

// `collaborator.products`
async function productsOf(collaboratorId: number): Promise<Link[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} INNER JOIN ${table("affiliates_links")} ON ${column("links", "id")} = ${column("affiliates_links", "link_id")} WHERE ${column("affiliates_links", "affiliate_id")} = ${collaboratorId}`,
  );
  return rows.map((row) => castRow<Link>("Link", row));
}

const collabFlagCleared = (link: Link): Partial<Link> => ({ flags: LinkFlags.set(link.flags, "is_collab", false) });

// Why the collaboration cannot be ended here, or null. Reads only: nothing has been written.
export async function endBlocker(row: CollaboratorEndRow): Promise<string | null> {
  if (row.seller_id === null || row.affiliate_user_id === null) return "a collaboration without a seller or an account";
  const points = row.affiliate_basis_points;
  if (points !== null && (points < MIN_BASIS_POINTS || points > MAX_BASIS_POINTS))
    return "a collaboration whose commission is outside the allowed range, which fails validation";
  if (points === null && (Number(row.flags) & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0)
    return "an all-products collaboration without a commission, which fails validation";

  const users = await selectRows(
    Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "id")} IN (${row.seller_id}, ${row.affiliate_user_id})`,
  );
  if (users.length < (row.seller_id === row.affiliate_user_id ? 1 : 2))
    return "a collaboration whose seller or account is missing";

  for (const link of await productsOf(row.id)) {
    // Validating the changed record also refuses a save Node has not ported, before anything is written.
    const product = Links.load(link);
    product.assign(collabFlagCleared(link));
    if (!(await Links.valid(product))) return "a product that would fail its own validation";
  }
  return null;
}

// `mark_deleted!`, then `products.each { _1.update!(is_collab: false) }`
export async function markCollaboratorDeletedBang(row: CollaboratorEndRow): Promise<void> {
  const record = Collaborators.load(row);
  await collaboratorDeletion.markDeletedBang(record);
  for (const link of await productsOf(row.id)) {
    await Links.updateBang(Links.load(link), collabFlagCleared(link));
  }
}

export type MailTarget =
  | typeof ENDED_BY_SELLER_MAIL
  | typeof ENDED_BY_AFFILIATE_USER_MAIL
  | typeof INVITATION_ACCEPTED_MAIL
  | typeof INVITATION_DECLINED_MAIL
  | typeof INVITED_MAIL
  | typeof CREATION_MAIL;

export async function deliverCollaboratorMail(method: MailTarget, collaboratorId: number): Promise<void> {
  await deliverLater(
    currentJobsRuntime(),
    { mailer: AFFILIATE_MAILER, method, args: [collaboratorId] },
    mailRoute(AFFILIATE_MAILER, method),
  );
}

export const CollaboratorInvitations = defineModel<InvitationRow>({
  rubyClass: "CollaboratorInvitation",
  prismaModel: "CollaboratorInvitation",
  delegate: (tx) => tx.collaboratorInvitation as never,
});

// `collaborator.collaborator_invitation`, then `invitation.destroy!`
export async function destroyInvitationBang(collaboratorId: number): Promise<void> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`collaborator_invitations`.*")} FROM ${table("collaborator_invitations")} WHERE ${column("collaborator_invitations", "collaborator_id")} = ${collaboratorId} LIMIT 1`,
  );
  await CollaboratorInvitations.destroyBang(
    CollaboratorInvitations.load(castRow<InvitationRow>("CollaboratorInvitation", row!)),
  );
}
