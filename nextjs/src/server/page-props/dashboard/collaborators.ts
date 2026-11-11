// CollaboratorsPresenter#index_props, IncomingCollaboratorsPresenter#index_props and CollaboratorPresenter#inertia_shared_props.
import { Prisma, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { column, columnIn, selectRows, table } from "../../models/sql.ts";
import type { LinkRow, UserRow } from "../../presenters/product-reads.ts";
import { longUrl } from "../../presenters/product.ts";
import { NotPortedError } from "../not-ported.ts";
import { avatarUrl, displayName } from "../signed-in/presenters.ts";

import { hasBrazilianStripeConnectAccount, hasValidPayoutInfo } from "./payout-info.ts";

export const DEFAULT_PERCENT_COMMISSION = 50;

type CollaboratorRow = {
  id: number;
  affiliate_user_id: number | null;
  affiliate_basis_points: number | null;
  flags: number;
};

type ProductAffiliateRow = { affiliate_id: number; affiliate_basis_points: number | null; product_id: bigint; product_name: string };

// Affiliate#affiliate_percentage
const percentage = (basisPoints: number | null) => (basisPoints === null ? null : Math.floor(basisPoints / 100));

// has_flags 1 => :apply_to_all_products, 3 => :dont_show_as_co_creator (flag_shih_tzu stores flag n as 2**(n - 1))
const APPLY_TO_ALL_PRODUCTS_FLAG = 1;
const DONT_SHOW_AS_CO_CREATOR_FLAG = 4;

// `seller.collaborators.alive`
export async function aliveCollaborators(sellerId: bigint): Promise<CollaboratorRow[]> {
  const a = (name: string) => column("affiliates", name);
  return selectRows<CollaboratorRow>(
    Prisma.sql`SELECT ${a("id")}, ${a("affiliate_user_id")}, ${a("affiliate_basis_points")}, ${a("flags")} FROM ${table("affiliates")} WHERE ${a("seller_id")} = ${sellerId} AND ${a("type")} = 'Collaborator' AND ${a("deleted_at")} IS NULL ORDER BY ${a("id")} ASC`,
  );
}

// `seller.incoming_collaborators.alive.exists?`
export async function hasIncomingCollaborators(sellerId: bigint): Promise<boolean> {
  const a = (name: string) => column("affiliates", name);
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("affiliates")} WHERE ${a("affiliate_user_id")} = ${sellerId} AND ${a("type")} = 'Collaborator' AND ${a("deleted_at")} IS NULL LIMIT 1`,
  );
  return rows.length > 0;
}

async function invitedCollaboratorIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await selectRows<{ collaborator_id: bigint }>(
    Prisma.sql`SELECT ${column("collaborator_invitations", "collaborator_id")} FROM ${table("collaborator_invitations")} WHERE ${column("collaborator_invitations", "collaborator_id")} IN (${Prisma.join(ids)})`,
  );
  return new Set(rows.map((row) => Number(row.collaborator_id)));
}

// `collaborator.collaborator_invitation.present?`
export async function hasCollaboratorInvitation(collaboratorId: number): Promise<boolean> {
  return (await invitedCollaboratorIds([collaboratorId])).has(collaboratorId);
}

async function productAffiliates(ids: number[]): Promise<ProductAffiliateRow[]> {
  if (ids.length === 0) return [];
  const pa = (name: string) => column("affiliates_links", name);
  return selectRows<ProductAffiliateRow>(
    Prisma.sql`SELECT ${pa("affiliate_id")} AS affiliate_id, ${pa("affiliate_basis_points")} AS affiliate_basis_points, ${column("links", "id")} AS product_id, ${column("links", "name")} AS product_name FROM ${table("affiliates_links")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${pa("link_id")} WHERE ${pa("affiliate_id")} IN (${Prisma.join(ids)}) ORDER BY ${pa("id")} ASC`,
  );
}

export async function collaboratorsIndexProps(seller: User): Promise<Record<string, unknown>> {
  const collaborators = await aliveCollaborators(seller.id);
  const ids = collaborators.map((collaborator) => collaborator.id);
  const [invited, assignments] = await Promise.all([invitedCollaboratorIds(ids), productAffiliates(ids)]);
  const users = new Map((await db.user.findMany({ where: { id: { in: collaborators.map((c) => c.affiliate_user_id!) } } })).map((user) => [user.id, user]));

  const props: Record<string, unknown>[] = [];
  for (const collaborator of collaborators) {
    const user = users.get(BigInt(collaborator.affiliate_user_id!))!;
    const own = percentage(collaborator.affiliate_basis_points);
    props.push({
      id: externalId(collaborator.id),
      email: user.email,
      name: displayName(user, { preferEmailOverDefaultUsername: true }),
      avatar_url: await avatarUrl(user),
      apply_to_all_products: (collaborator.flags & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0,
      percent_commission: own ?? DEFAULT_PERCENT_COMMISSION,
      setup_incomplete: !(await hasValidPayoutInfo(user)),
      dont_show_as_co_creator: (collaborator.flags & DONT_SHOW_AS_CO_CREATOR_FLAG) !== 0,
      invitation_accepted: !invited.has(collaborator.id),
      products: assignments
        .filter((assignment) => assignment.affiliate_id === collaborator.id)
        .map((assignment) => {
          const commission = percentage(assignment.affiliate_basis_points) ?? own;
          // `.compact` drops the nil url, and a nil commission with it.
          return { id: externalId(assignment.product_id), name: assignment.product_name, ...(commission === null ? {} : { percent_commission: commission }) };
        }),
    });
  }
  return { collaborators: props, has_incoming_collaborators: await hasIncomingCollaborators(seller.id) };
}

type IncomingRow = CollaboratorRow & { seller_id: number; has_invitation: number | bigint | boolean };

// IncomingCollaboratorsPresenter#index_props: the collaborations the seller was invited to, pending invitations first.
export async function incomingCollaboratorsProps(seller: User): Promise<Record<string, unknown>> {
  const a = (name: string) => column("affiliates", name);
  const invitationId = column("collaborator_invitations", "id");
  const rows = await selectRows<IncomingRow>(
    Prisma.sql`SELECT ${a("id")}, ${a("seller_id")}, ${a("affiliate_user_id")}, ${a("affiliate_basis_points")}, ${a("flags")}, (${invitationId} IS NOT NULL) AS has_invitation FROM ${table("affiliates")} LEFT JOIN ${table("collaborator_invitations")} ON ${column("collaborator_invitations", "collaborator_id")} = ${a("id")} WHERE ${a("affiliate_user_id")} = ${seller.id} AND ${a("type")} = 'Collaborator' AND ${a("deleted_at")} IS NULL ORDER BY CASE WHEN ${invitationId} IS NULL THEN 1 ELSE 0 END, ${a("id")} ASC`,
  );
  const ids = rows.map((row) => row.id);
  const assignments = ids.length === 0 ? [] : await incomingProductAffiliates(ids);
  const links = new Map<bigint, LinkRow>();
  if (assignments.length > 0) {
    const found = await selectRows<LinkRow>(
      Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${columnIn("links", "id", [...new Set(assignments.map((assignment) => assignment.link_id))])}`,
    );
    for (const link of found) links.set(BigInt(link.id), link);
  }
  const userIds = [...new Set([...rows.map((row) => BigInt(row.seller_id)), ...[...links.values()].map((link) => BigInt(link.user_id!))])];
  const users = new Map((await db.user.findMany({ where: { id: { in: userIds } } })).map((user) => [user.id, user]));

  const collaborators: Record<string, unknown>[] = [];
  for (const row of rows) {
    const owner = users.get(BigInt(row.seller_id))!;
    const own = percentage(row.affiliate_basis_points);
    collaborators.push({
      percent_commission: own ?? DEFAULT_PERCENT_COMMISSION,
      apply_to_all_products: (row.flags & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0,
      dont_show_as_co_creator: (row.flags & DONT_SHOW_AS_CO_CREATOR_FLAG) !== 0,
      id: externalId(row.id),
      invitation_accepted: Number(row.has_invitation) === 0,
      products: assignments
        .filter((assignment) => assignment.affiliate_id === row.id)
        .map((assignment) => {
          const link = links.get(BigInt(assignment.link_id));
          // Rails raises on a product row that is gone.
          if (link === undefined) throw new NotPortedError("An incoming collaboration on a product that no longer exists");
          const commission = percentage(assignment.affiliate_basis_points) ?? own;
          return {
            id: externalId(link.id),
            name: link.name,
            ...(commission === null ? {} : { percent_commission: commission }),
            url: longUrl(link, users.get(BigInt(link.user_id!)) as unknown as UserRow),
          };
        }),
      seller_avatar_url: await avatarUrl(owner),
      seller_email: owner.email,
      seller_name: displayName(owner, { preferEmailOverDefaultUsername: true }),
    });
  }
  return { collaborators };
}

async function incomingProductAffiliates(ids: number[]) {
  const pa = (name: string) => column("affiliates_links", name);
  return selectRows<{ affiliate_id: number; affiliate_basis_points: number | null; link_id: bigint }>(
    Prisma.sql`SELECT ${pa("affiliate_id")}, ${pa("affiliate_basis_points")}, ${pa("link_id")} FROM ${table("affiliates_links")} WHERE ${pa("affiliate_id")} IN (${Prisma.join(ids)}) ORDER BY ${pa("id")} ASC`,
  );
}

// CollaboratorPresenter#inertia_shared_props
export async function collaboratorsSharedProps(seller: User): Promise<Record<string, unknown>> {
  return { collaborators_disabled_reason: (await hasBrazilianStripeConnectAccount(seller.id)) ? "Collaborators with Brazilian Stripe accounts are not supported." : null };
}

// ---- new / edit ----

export const MIN_PERCENT_COMMISSION = 1;
export const MAX_PERCENT_COMMISSION = 50;
export const MAX_PRODUCTS_WITH_AFFILIATES_TO_SHOW = 10;
const ARCHIVED_FLAG = 2n ** 4n;

export type CollaboratorRecord = CollaboratorRow & { seller_id: number };

// `Collaborator.alive.find_by_external_id(id)`, from any seller.
export async function findAliveCollaborator(id: number): Promise<CollaboratorRecord | null> {
  const a = (name: string) => column("affiliates", name);
  const [row] = await selectRows<CollaboratorRecord>(
    Prisma.sql`SELECT ${a("id")}, ${a("seller_id")}, ${a("affiliate_user_id")}, ${a("affiliate_basis_points")}, ${a("flags")} FROM ${table("affiliates")} WHERE ${a("type")} = 'Collaborator' AND ${a("deleted_at")} IS NULL AND ${a("id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

type FormOptions = { applyToAllProducts: boolean; dontShowAsCoCreator: boolean; email: string | null; percentCommission: number | null; title: string };

// CollaboratorPresenter#all_products
async function allProducts(seller: User, collaborator: CollaboratorRecord | null, options: FormOptions) {
  const l = (name: string) => column("links", name);
  const products = await selectRows<{ id: bigint; name: string; draft: number | boolean | null; purchase_disabled_at: Date | null; flags: bigint }>(
    Prisma.sql`SELECT ${l("id")}, ${l("name")}, ${l("draft")}, ${l("purchase_disabled_at")}, ${l("flags")} FROM ${table("links")} WHERE ${l("user_id")} = ${seller.id} AND ${l("deleted_at")} IS NULL ORDER BY ${l("id")} ASC`,
  );
  const visible = products.filter((product) => (BigInt(product.flags) & ARCHIVED_FLAG) === 0n);
  if (visible.length === 0) return [];
  const pa = (name: string) => column("affiliates_links", name);
  const a = (name: string) => column("affiliates", name);
  const assignments = await selectRows<{ link_id: number; affiliate_id: number; type: string; deleted_at: Date | null; affiliate_basis_points: number | null; flags: bigint }>(
    Prisma.sql`SELECT ${pa("link_id")} AS link_id, ${pa("affiliate_id")} AS affiliate_id, ${a("type")} AS type, ${a("deleted_at")} AS deleted_at, ${pa("affiliate_basis_points")} AS affiliate_basis_points, ${pa("flags")} AS flags FROM ${table("affiliates_links")} INNER JOIN ${table("affiliates")} ON ${a("id")} = ${pa("affiliate_id")} WHERE ${pa("link_id")} IN (${Prisma.join(visible.map((product) => product.id))}) ORDER BY ${pa("id")} ASC`,
  );
  // With :collab_and_affiliates adding a collaborator keeps the product's affiliates, so there is nothing to warn about.
  const affiliatesRemovedOnCollab = !(await isFeatureEnabled("collab_and_affiliates", userActor(seller.id)));
  return visible.map((product) => {
    const own = assignments.filter((assignment) => assignment.link_id === Number(product.id));
    const productAffiliate = collaborator ? own.find((assignment) => assignment.affiliate_id === collaborator.id) : undefined;
    const hasAnotherCollaborator = own.some((assignment) => assignment.type === "Collaborator" && assignment.deleted_at === null && assignment.affiliate_id !== collaborator?.id);
    const published = product.purchase_disabled_at === null && !Number(product.draft);
    return {
      id: externalId(product.id),
      name: product.name,
      has_another_collaborator: hasAnotherCollaborator,
      has_affiliates: affiliatesRemovedOnCollab && own.some((assignment) => assignment.type === "DirectAffiliate" && assignment.deleted_at === null),
      published,
      enabled: collaborator ? productAffiliate !== undefined : !hasAnotherCollaborator && published,
      percent_commission: percentage(productAffiliate?.affiliate_basis_points ?? null) ?? options.percentCommission,
      dont_show_as_co_creator: (productAffiliate !== undefined && (BigInt(productAffiliate.flags) & 1n) !== 0n) || options.dontShowAsCoCreator,
    };
  });
}

// CollaboratorPresenter#collaborator_form_props, then `.compact` on each hash.
async function formProps(seller: User, collaborator: CollaboratorRecord | null, options: FormOptions) {
  const compact = <T extends Record<string, unknown>>(hash: T) => Object.fromEntries(Object.entries(hash).filter(([, value]) => value !== null && value !== undefined));
  return {
    form_data: compact({
      id: collaborator ? externalId(collaborator.id) : null,
      email: options.email,
      apply_to_all_products: options.applyToAllProducts,
      percent_commission: options.percentCommission,
      dont_show_as_co_creator: options.dontShowAsCoCreator,
      products: await allProducts(seller, collaborator, options),
    }),
    page_metadata: compact({
      default_percent_commission: DEFAULT_PERCENT_COMMISSION,
      min_percent_commission: MIN_PERCENT_COMMISSION,
      max_percent_commission: MAX_PERCENT_COMMISSION,
      max_products_with_affiliates_to_show: MAX_PRODUCTS_WITH_AFFILIATES_TO_SHOW,
      title: options.title,
    }),
  };
}

export const newCollaboratorProps = (seller: User) =>
  formProps(seller, null, { applyToAllProducts: true, dontShowAsCoCreator: false, email: "", percentCommission: DEFAULT_PERCENT_COMMISSION, title: "New collaborator" });

export async function editCollaboratorProps(seller: User, collaborator: CollaboratorRecord) {
  const user = (await db.user.findUnique({ where: { id: BigInt(collaborator.affiliate_user_id!) } }))!;
  return formProps(seller, collaborator, {
    applyToAllProducts: (collaborator.flags & APPLY_TO_ALL_PRODUCTS_FLAG) !== 0,
    dontShowAsCoCreator: (collaborator.flags & DONT_SHOW_AS_CO_CREATOR_FLAG) !== 0,
    email: null,
    percentCommission: percentage(collaborator.affiliate_basis_points),
    title: displayName(user, { preferEmailOverDefaultUsername: true }) ?? "",
  });
}
