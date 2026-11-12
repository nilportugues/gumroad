// Link#publish! (app/models/link.rb) for a product whose publication needs nothing outside the database: content moderation that passes
// without a model call, no seller plan offer, no direct affiliate for all products, no video transcoding and no shipping destinations.
// `assertPlainPublish` refuses the rest before the first statement, so a product it hands back to Rails has changed nothing.
//
// Rails-recorded proof: spec/requests/api/v2/product_enable_parity_spec.rb, replayed by parity/__tests__/api-v2-ws17c.replay.test.ts
// (row diffs, response, jobs); the order of the statements is pinned by link-publish.test.ts against the fixtures' `timeline`.
import { Prisma, type Link, type User } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { LinkFlags, Links } from "./link.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, selectRows, table } from "./sql.ts";

// Link::UNPUBLISHED_BY_ADMIN_MESSAGE
export const UNPUBLISHED_BY_ADMIN_MESSAGE =
  "This product was unpublished by Gumroad and cannot be republished by the seller.";
export const EMAIL_CONFIRMATION_MESSAGE = "You have to confirm your email address before you can do that.";
// User::Tier::TIER_3, from which videos are transcoded on publish
const TIER_3 = 100_000;
const APPLY_TO_ALL_PRODUCTS = 1;
const notPorted = (what: string): never => {
  throw new NotPortedError(what);
};

const exists = async (sql: Prisma.Sql) => {
  const [row] = await selectRows<{ found: number | bigint }>(sql);
  return Number(row?.found ?? 0) > 0;
};

// What publish! does that Node does not follow, checked on the product and seller as loaded.
export async function assertPlainPublish(product: Link, seller: User): Promise<void> {
  // A deleted product is restored by the publish, which locks the seller and the product's permalink claim.
  if (product.deleted_at !== null) notPorted("the publication of a deleted product");
  // enforce_shipping_destinations_presence! reads the product's destinations.
  if (LinkFlags.isSet(product.flags, "is_physical")) notPorted("the publication of a physical product");
  // content_moderation_check calls the classifier unless the flag is off or the seller is verified.
  if (seller.verified !== true && (await isFeatureEnabled("content_moderation")))
    notPorted("content moderation of an unverified seller");
  // enforce_seller_plan!: the offer of the paid-publish experiment is created (and charged for) on a first publish.
  if (product.draft && (await isFeatureEnabled("seller_plan_gate", userActor(seller.id))))
    notPorted("a first publish in the seller plan experiment");
  // enforce_merchant_account_exits_for_new_users!: the message of a seller that cannot publish names their payout rejection.
  if (seller.payment_address == null || seller.payment_address.trim() === "")
    notPorted("the publication by a seller whose payment method is not a payment address");
  // auto_transcode_videos?: a tier 3 seller, or a product with sales (counted in Elasticsearch).
  if ((seller.tier_state ?? 0) >= TIER_3) notPorted("the publication by a seller whose videos are transcoded");
  if (
    await exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "link_id")} = ${product.id}) AS found`,
    )
  )
    notPorted("the publication of a product that has sales");
  // user.direct_affiliates.alive.apply_to_all_products: each is added to the product and mailed.
  if (
    await exists(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("affiliates")} WHERE ${column("affiliates", "seller_id")} = ${seller.id} AND ${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "deleted_at")} IS NULL AND ${column("affiliates", "flags")} & ${APPLY_TO_ALL_PRODUCTS} = ${APPLY_TO_ALL_PRODUCTS}) AS found`,
    )
  )
    notPorted("the publication by a seller with a direct affiliate for all products");
}

const activeHold = (product: Link, lock: boolean) =>
  exists(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("product_sales_holds")} WHERE ${column("product_sales_holds", "product_id")} = ${product.id} AND ${column("product_sales_holds", "released_at")} IS NULL${lock ? Prisma.raw(" FOR UPDATE") : Prisma.empty}) AS found`,
  );

// enforce_not_unpublished_by_admin!, enforce_no_active_sales_hold!, enforce_user_email_confirmation!: the refusal, or null.
async function refusal(flags: bigint, product: Link, seller: User, lock = false): Promise<string | null> {
  if (LinkFlags.isSet(flags, "is_unpublished_by_admin")) return UNPUBLISHED_BY_ADMIN_MESSAGE;
  if (await activeHold(product, lock)) return UNPUBLISHED_BY_ADMIN_MESSAGE;
  if (!lock && seller.confirmed_at === null) return EMAIL_CONFIRMATION_MESSAGE;
  return null;
}

// Returns the message Rails' LinkInvalid carries when the publish is refused (nothing written), else publishes.
export async function publishBang(
  product: Link,
  seller: User,
  now: () => Date = () => new Date(),
): Promise<string | null> {
  const first = await refusal(product.flags, product, seller);
  if (first !== null) return first;

  const record = Links.load(product);
  const wasDraft = product.draft;
  record.assign({ purchase_disabled_at: null, deleted_at: null, draft: false });
  let refused: string | null = null;
  await transaction(async () => {
    // The row is read under the lock: another save may have changed the flags, or recorded the first publication, since it was loaded.
    const [locked] = await selectRows<{ flags: bigint; first_published_at: Date | null }>(
      Prisma.sql`SELECT ${column("links", "flags")}, ${column("links", "first_published_at")} FROM ${table("links")} WHERE ${column("links", "id")} = ${product.id} LIMIT 1 FOR UPDATE`,
    );
    if (wasDraft) record.set("first_published_at", locked?.first_published_at ?? now());
    const flags = BigInt(locked?.flags ?? product.flags);
    record.set("flags", flags);
    refused = await refusal(flags, product, seller, true);
    if (refused !== null) return;
    record.set("flags", LinkFlags.set(flags, "transcode_videos_on_purchase", true));
    await Links.saveBang(record, { now });
  });
  return refused;
}
