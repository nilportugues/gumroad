// Port of app/sidekiq/refresh_audience_member_job.rb: AudienceMember#refresh! rebuilds the row from the seller's purchases, follower and
// direct affiliates, saves it, or destroys it when nothing qualifies any more (under the row lock when it exists).
//
// Every source runs in Node: purchases (Purchase#should_be_audience_member? and #audience_member_details, with the subscription,
// variant and license reads), the follower, and direct affiliates (Affiliate#should_be_audience_member? and its product rows). A
// purchase or affiliate row with no created_at is handed back: Ruby raises there and the statements before it are read-only.
// Golden: __fixtures__/refresh-audience-member-job.golden.json (scripts/golden/refresh-audience-member-job.rb).
import { Prisma, type Affiliate, type Follower, type Purchase, type User } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import {
  AudienceMembers,
  findAudienceMember,
  type AudienceMemberRecord,
  type Details,
} from "../../server/models/audience-member-record.ts";
import { sendsPosts } from "../../server/models/direct-affiliate.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findById } from "../../server/models/row-reads.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { castRow, column, findInBatches, quoteName, selectRows, table } from "../../server/models/sql.ts";
import { isValidEmailFormat } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
const AUDIENCE_PURCHASE_STATES = ["successful", "gift_receiver_purchase_successful", "not_charged"];
const SubscriptionFlags = defineFlags("subscriptions", { 1: "is_test_subscription" }, { queryMode: "bit_operator" });

// Time#iso8601 of a UTC time.
const iso8601 = (time: Date): string => time.toISOString().replace(".000Z", "Z");

// A Ruby NoMethodError on nil: `seller.sales` for a seller that does not exist.
class NoMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMethodError";
  }
}

// The seller id as `find_or_initialize_by(seller_id:)` casts it; anything else is a Ruby cast Node does not reproduce.
function sellerIdFrom(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new HandBackToRuby(`seller_id ${JSON.stringify(value)} is not an Integer`);
}

const columnsOf = (model: "Affiliate" | "User") =>
  Prisma.dmmf.datamodel.models.find((m) => m.name === model)!.fields.filter((field) => field.kind !== "object");

// `includes(:affiliate_user).where(users: { email: })` eager loads, so every column of both tables is selected under tN_rM aliases.
function eagerLoadedColumns(): Prisma.Sql {
  const aliased = (model: "Affiliate" | "User", alias: string) =>
    columnsOf(model).map(
      (field, index) =>
        `${quoteName(model === "User" ? "users" : "affiliates")}.${quoteName(field.name)} AS ${alias}_r${index}`,
    );
  return Prisma.raw([...aliased("Affiliate", "t0"), ...aliased("User", "t1")].join(", "));
}

// The inverse of eagerLoadedColumns for one row.
function unaliased(model: "Affiliate" | "User", alias: "t0" | "t1", row: Record<string, unknown>) {
  return Object.fromEntries(columnsOf(model).map((field, index) => [field.name, row[`${alias}_r${index}`]]));
}

// Purchase#should_be_audience_member?. Its `result &= ...` terms all run, so a subscription purchase loads its subscription (and
// raises on a missing one) whatever the earlier terms came out as.
async function purchaseShouldBeAudienceMember(purchase: PurchaseRecord): Promise<boolean> {
  const row = purchase.row;
  let result = row.can_contact === true;
  result &&= row.purchase_state !== null && AUDIENCE_PURCHASE_STATES.includes(row.purchase_state);
  result &&= !purchase.flag("is_gift_sender_purchase");
  result &&= isValidEmailFormat(row.email);
  if (row.subscription_id === null) {
    result &&= row.stripe_refunded !== true;
    return result && (row.chargeback_date === null || purchase.flag("chargeback_reversed"));
  }
  const subscription = await purchase.subscriptionRow();
  if (subscription === null) throw new NoMethodError("undefined method 'deactivated_at' for nil");
  return (
    result &&
    purchase.flag("is_original_subscription_purchase") &&
    !purchase.flag("is_archived_original_subscription_purchase") &&
    subscription.deactivated_at === null &&
    !SubscriptionFlags.isSet(subscription.flags, "is_test_subscription")
  );
}

// Purchase#audience_member_details; the row's own compaction drops the blank values (`compact_blank`).
async function purchaseDetails(purchase: PurchaseRecord): Promise<Details> {
  const row = purchase.row;
  if (row.created_at === null) throw new HandBackToRuby("a purchase with no created_at");
  const variantIds = await selectRows<{ id: unknown }>(
    Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${row.id}`,
  );
  const subscription = row.subscription_id === null ? null : await purchase.subscriptionRow();
  const license = await purchase.license();
  return {
    id: Number(row.id),
    country: (isBlank(row.country) ? row.ip_country : row.country) ?? "",
    created_at: iso8601(row.created_at),
    product_id: row.link_id === null ? null : Number(row.link_id),
    variant_ids: variantIds.map((variant) => Number(variant.id)),
    price_cents: row.price_cents,
    subscription_cancelled: subscription?.cancelled_at != null,
    license_uses: license?.uses ?? null,
  };
}

async function applyRefresh(member: AudienceMemberRecord, sellerId: bigint, now: () => Date): Promise<void> {
  // The stored address of a row that exists (lowercased), the job's argument for one that does not.
  const email = member.get("email");
  const details: Details = {};
  member.set("details", details as never);

  const seller = await findById("User", sellerId);
  if (seller === null) throw new NoMethodError("undefined method 'sales' for nil");

  const sales = Prisma.sql`${column("purchases", "seller_id")} = ${sellerId} AND ${column("purchases", "email")} = ${email}`;
  await findInBatches<Record<string, unknown>>("purchases", sales, FIND_EACH_BATCH_SIZE, async (rows) => {
    for (const row of rows) {
      const purchase = new PurchaseRecord(castRow<Purchase>("Purchase", row), null);
      const purchases = ((details.purchases as Details[] | undefined) ??= []);
      if (await purchaseShouldBeAudienceMember(purchase)) purchases.push(await purchaseDetails(purchase));
    }
  });

  const [follower] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${Prisma.raw("`followers`.*")} FROM ${table("followers")} WHERE ${column("followers", "followed_id")} = ${sellerId} AND ${column("followers", "email")} = ${email} LIMIT 1`,
  );
  if (follower !== undefined) {
    const row = castRow<Follower>("Follower", follower);
    if (row.confirmed_at !== null && isValidEmailFormat(row.email))
      details.follower = { id: Number(row.id), created_at: iso8601(row.created_at!) };
  }

  const affiliates = Prisma.sql`${column("affiliates", "type")} = 'DirectAffiliate' AND ${column("affiliates", "seller_id")} = ${sellerId} AND ${column("users", "email")} = ${email}`;
  await findInBatches<Record<string, unknown>>(
    "affiliates",
    affiliates,
    FIND_EACH_BATCH_SIZE,
    async (rows) => {
      for (const row of rows) {
        const affiliate = castRow<Affiliate>("Affiliate", unaliased("Affiliate", "t0", row));
        const affiliateUser = castRow<User>("User", unaliased("User", "t1", row));
        // Affiliate#should_be_audience_member?: the scope fixes `type`, and `seller.present?` holds because the seller was read above.
        if (affiliate.deleted_at !== null || !sendsPosts(affiliate) || !isValidEmailFormat(affiliateUser.email))
          continue;
        if (affiliate.created_at === null) throw new HandBackToRuby("an affiliate with no created_at");
        const list = ((details.affiliates as Details[] | undefined) ??= []);
        const productAffiliates = await selectRows<Record<string, unknown>>(
          Prisma.sql`SELECT ${Prisma.raw("`affiliates_links`.*")} FROM ${table("affiliates_links")} WHERE ${column("affiliates_links", "affiliate_id")} = ${affiliate.id}`,
        );
        for (const productAffiliate of productAffiliates)
          list.push({
            id: Number(affiliate.id),
            product_id: productAffiliate.link_id === null ? null : Number(productAffiliate.link_id),
            created_at: iso8601(affiliate.created_at),
          });
      }
    },
    eagerLoadedColumns(),
    Prisma.sql`LEFT OUTER JOIN ${table("users")} ON ${column("users", "id")} = ${column("affiliates", "affiliate_user_id")}`,
  );

  member.set("details", details as never);
  if (await AudienceMembers.valid(member)) await AudienceMembers.saveBang(member, { now });
  else if (member.persisted) await AudienceMembers.destroyBang(member);
}

export const refreshAudienceMemberJobWith = modelJob({ min: 2 }, async ([email, sellerIdArg], deps) => {
  if (typeof email !== "string") throw new HandBackToRuby(`email ${JSON.stringify(email)} is not a String`);
  const sellerId = sellerIdFrom(sellerIdArg);

  const found = await findAudienceMember(email, sellerId);
  const member = found ?? AudienceMembers.build({ email, seller_id: sellerId, details: {} as never });
  // `persisted? ? with_lock { apply_refresh } : apply_refresh`
  if (found !== null) await AudienceMembers.withLock(member, () => applyRefresh(member, sellerId, deps.now));
  else await applyRefresh(member, sellerId, deps.now);
});

export const refreshAudienceMemberJob = refreshAudienceMemberJobWith();
