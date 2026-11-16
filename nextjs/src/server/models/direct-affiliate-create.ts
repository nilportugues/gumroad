// The save `AffiliatesController#create` makes for one new DirectAffiliate with one ProductAffiliate (app/models/direct_affiliate.rb,
// product_affiliate.rb, Affiliate::AudienceMember): the product's row lock, the affiliate, the assignment with its workflow schedule
// token, the seller's audience member, and after the commit the schedule job and the invitation mail.
//
// A fee outside 1%..75% is answered, not handed back: `creationBlocker` returns its validation message once nothing earlier fails.
//
// Not ported, and refused before the first write by `creationBlocker`: more than one product or all products (the presenter decides the
// list), a destination URL (validated), a collab product, a deleted product, a Brazilian Stripe Connect account on
// either side, an email Gumroad would not treat as an audience member, and any live direct affiliation of the account (uniqueness).
import { randomUUID } from "node:crypto";

import { Prisma, type Affiliate, type ProductAffiliate } from "@prisma/client";

import { findOrInitializeAudienceMember, AudienceMembers, type Details } from "./audience-member-record.ts";
import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import { DirectAffiliates, DIRECT_AFFILIATE, type AffiliateRecord } from "./direct-affiliate-removal.ts";
import { enqueueWorkflowSchedule, PRODUCT_AFFILIATES } from "./product-affiliate.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, selectRows, table } from "./sql.ts";
import { isValidEmailFormat, NotPortedError } from "./user.ts";

export const SEND_POSTS_FLAG = 2;
// Affiliate::BasisPointsValidations
const MIN_BASIS_POINTS = 100;
const MAX_BASIS_POINTS = 7500;
const BRAZIL = "BR";
// Link: `has_flags 28 => :is_collab`
const IS_COLLAB_FLAG = 1n << 27n;

export type NewAffiliate = {
  sellerId: number;
  affiliateUserId: number;
  affiliateUserEmail: string;
  // The affiliate's own fee, and the one on its single product.
  basisPoints: number;
  productId: number;
  productBasisPoints: number;
};

export const FEE_RANGE_MESSAGE = `Affiliate commission must be between ${MIN_BASIS_POINTS / 100}% and ${MAX_BASIS_POINTS / 100}%.`;

export const feeOutsideRange = (basisPoints: number | null): boolean =>
  basisPoints !== null && (basisPoints < MIN_BASIS_POINTS || basisPoints > MAX_BASIS_POINTS);

// A shape Node answers itself (`refusal`) or one it passes to Rails whole (a string).
export type Blocker = string | { refusal: string };

// The shape of the request, as `creationBlocker` reads it. `enabledProducts` are the ones sent with `enabled` set.
export type Requested = {
  applyToAllProducts: boolean;
  enabledProducts: { destinationUrl: unknown }[];
  destinationUrl: unknown;
};

// Any value other than nil: Rails stores an empty string as sent, which this port would store as NULL.
const present = (value: unknown) => value !== null && value !== undefined;

// Why the creation cannot be answered here, or null. Reads only: nothing has been written.
export async function creationBlocker(
  requested: Requested,
  affiliate: Pick<NewAffiliate, "sellerId" | "affiliateUserId" | "affiliateUserEmail" | "basisPoints" | "productId">,
  // An edit already has the live affiliation the uniqueness read looks for.
  options: { editing?: boolean } = {},
): Promise<Blocker | null> {
  if (requested.applyToAllProducts) return "an affiliate for all products, whose list the presenter decides";
  if (requested.enabledProducts.length !== 1) return "an affiliate with several products";
  if (present(requested.destinationUrl) || requested.enabledProducts.some((p) => present(p.destinationUrl)))
    return "an affiliate with a destination URL, whose format is validated";
  if (!isValidEmailFormat(affiliate.affiliateUserEmail)) return "an account whose email is not an audience member's";

  const [product] = await selectRows<{ flags: unknown; deleted_at: unknown }>(
    Prisma.sql`SELECT ${column("links", "flags")}, ${column("links", "deleted_at")} FROM ${table("links")} WHERE ${column("links", "id")} = ${affiliate.productId} AND ${column("links", "user_id")} = ${affiliate.sellerId} LIMIT 1`,
  );
  if (product === undefined) return "a product the seller does not have";
  if (product.deleted_at !== null) return "a deleted product";
  if ((BigInt(product.flags as bigint) & IS_COLLAB_FLAG) !== 0n)
    return "a collab product, which cannot have affiliates";

  const [brazilian] = await selectRows(
    Prisma.sql`SELECT ${column("merchant_accounts", "id")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} IN (${affiliate.sellerId}, ${affiliate.affiliateUserId}) AND ${column("merchant_accounts", "country")} = ${BRAZIL} LIMIT 1`,
  );
  if (brazilian !== undefined) return "an account with a Brazilian Stripe Connect account";

  // The range validation comes before the uniqueness one, and the Brazilian check (Affiliate's own) before both.
  if (affiliate.basisPoints < MIN_BASIS_POINTS || affiliate.basisPoints > MAX_BASIS_POINTS)
    return { refusal: FEE_RANGE_MESSAGE };

  if (options.editing === true) return null;
  const [existing] = await selectRows(
    Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "type")} = ${DIRECT_AFFILIATE} AND ${column("affiliates", "seller_id")} = ${affiliate.sellerId} AND ${column("affiliates", "affiliate_user_id")} = ${affiliate.affiliateUserId} AND ${column("affiliates", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (existing !== undefined) return "an account the seller already has as an affiliate, whose uniqueness is validated";
  return null;
}

// Ruby's `to_i` on a param: a number truncates, a string reads its leading integer (underscores between digits allowed), else 0.
// Golden: parity/golden/ruby-to-i.json (parity/golden/ruby-to-i.rb).
export function rubyToI(value: string | number | null): number {
  const fail = () =>
    new NotPortedError("A fee that is not a finite number", "app/controllers/affiliates_controller.rb");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail();
    return Math.trunc(value) + 0;
  }
  const match = /^[\t\n\v\f\r ]*([+-]?\d+(?:_\d+)*)/u.exec(value ?? "");
  return match === null ? 0 : Number(match[1]!.replaceAll("_", "")) + 0;
}

const isoSecond = (time: Date) => `${time.toISOString().slice(0, 19)}Z`;

// Affiliate::AudienceMember#update_audience_member_with_added_product
async function addToAudienceMember(affiliate: AffiliateRecord, email: string, productId: number): Promise<void> {
  const sellerId = BigInt(affiliate.get("seller_id")!);
  const member = await findOrInitializeAudienceMember(email, sellerId);
  const details = { ...((member.get("details") ?? {}) as Details) };
  const affiliates = Array.isArray(details.affiliates) ? [...(details.affiliates as Record<string, unknown>[])] : [];
  if (affiliates.some((entry) => entry.id === affiliate.get("id") && entry.product_id === productId)) return;
  affiliates.push({
    id: affiliate.get("id"),
    product_id: productId,
    created_at: isoSecond(affiliate.get("created_at")!),
  });
  details.affiliates = affiliates;
  member.set("details", details as never);
  await AudienceMembers.saveBang(member);
}

const affiliateOf = (record: { ivars: Record<string, unknown> }) => record.ivars.affiliate as AffiliateRecord;

// `before_create :assign_workflow_schedule_token`: one token for the whole transaction.
const assignToken: Callback<ProductAffiliate> = {
  name: "assign_workflow_schedule_token",
  run(record, _ctx) {
    record.set("workflow_schedule_token", record.ivars.token as string);
  },
};

const updateAudienceMember: Callback<ProductAffiliate> = {
  name: "update_audience_member_with_added_product",
  async run(record) {
    await addToAudienceMember(affiliateOf(record), record.ivars.email as string, record.get("link_id")!);
  },
};

// `after_create :enqueue_workflow_jobs`: the first assignment of a token schedules it once the transaction commits.
const enqueueWorkflowJobs: Callback<ProductAffiliate> = {
  name: "enqueue_workflow_jobs",
  async run(record) {
    const token = record.get("workflow_schedule_token")!;
    const [first] = await selectRows<{ minimum: unknown }>(
      Prisma.sql`SELECT MIN(${column(PRODUCT_AFFILIATES, "id")}) AS \`minimum\` FROM ${table(PRODUCT_AFFILIATES)} WHERE ${column(PRODUCT_AFFILIATES, "workflow_schedule_token")} = ${token}`,
    );
    if (Number(first?.minimum) !== record.get("id")) return;
    await afterCommitEverywhere(() =>
      enqueueWorkflowSchedule(token, {
        now: () => new Date(),
        uuid: randomUUID,
        logError: (message) => console.error(message),
      }),
    );
  },
};

export const ProductAffiliates = defineModel<ProductAffiliate>({
  rubyClass: "ProductAffiliate",
  prismaModel: "ProductAffiliate",
  delegate: (tx) => tx.productAffiliate as never,
  beforeCreate: [assignToken],
  afterCreate: [updateAudienceMember, enqueueWorkflowJobs],
});

// `product.lock!` and `Affiliate.where(id:).lock.load`: ProductAffiliate locks its product, then its affiliate.
const lockProduct = (productId: number) =>
  selectRows(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1 FOR UPDATE`,
  );
const lockAffiliate = (affiliateId: number) =>
  selectRows(
    Prisma.sql`SELECT ${column("affiliates", "id")} FROM ${table("affiliates")} WHERE ${column("affiliates", "id")} = ${affiliateId} FOR UPDATE`,
  );

// `affiliate.save` for a new DirectAffiliate (send_posts on, no destination URL) with `product_affiliates.build(...)`, then the mail.
export async function createDirectAffiliate(input: NewAffiliate): Promise<{ id: number }> {
  return transaction(async () => {
    // lock_products_for_assignment_changes, before validation.
    await lockProduct(input.productId);
    const affiliate = DirectAffiliates.build({
      seller_id: input.sellerId,
      affiliate_user_id: input.affiliateUserId,
      affiliate_basis_points: input.basisPoints,
      destination_url: null,
      flags: SEND_POSTS_FLAG,
      type: DIRECT_AFFILIATE,
    } as Partial<Affiliate>);
    await DirectAffiliates.saveBang(affiliate);

    // The autosaved assignment: its own locks, then the uniqueness read, then the insert.
    await lockProduct(input.productId);
    await lockAffiliate(affiliate.get("id"));
    const [taken] = await selectRows(
      Prisma.sql`SELECT 1 AS \`one\` FROM ${table(PRODUCT_AFFILIATES)} WHERE ${column(PRODUCT_AFFILIATES, "affiliate_id")} = ${affiliate.get("id")} AND ${column(PRODUCT_AFFILIATES, "link_id")} = ${input.productId} LIMIT 1 FOR UPDATE`,
    );
    if (taken !== undefined) throw new Error("This affiliate already exists for the product");
    const assignment = ProductAffiliates.build({
      affiliate_id: affiliate.get("id"),
      link_id: input.productId,
      affiliate_basis_points: input.productBasisPoints,
      destination_url: null,
    });
    assignment.ivars.affiliate = affiliate;
    assignment.ivars.email = input.affiliateUserEmail;
    assignment.ivars.token = randomUUID();
    await ProductAffiliates.saveBang(assignment);
    return { id: affiliate.get("id") };
  });
}
