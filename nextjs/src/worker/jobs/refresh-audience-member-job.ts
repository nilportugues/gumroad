// Port of app/sidekiq/refresh_audience_member_job.rb: AudienceMember#refresh! rebuilds the row from the seller's purchases, follower and
// direct affiliates, saves it, or destroys it when nothing qualifies any more (under the row lock when it exists).
//
// Runs in Node for a buyer whose purchases all fail the cheap checks of Purchase#should_be_audience_member? (no subscription, and the
// buyer cannot be contacted, the sale is not in a sellable state or the address is malformed), whose only source is a follower, or who
// has no source at all. A purchase that could qualify (its details need the country, variants, subscription and license) and any
// direct affiliate are handed back; the statements before that are read-only, so Rails re-runs the job from the start.
// Golden: __fixtures__/refresh-audience-member-job.golden.json (scripts/golden/refresh-audience-member-job.rb).
import { Prisma, type Follower, type Purchase } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import {
  AudienceMembers,
  findAudienceMember,
  type AudienceMemberRecord,
  type Details,
} from "../../server/models/audience-member-record.ts";
import { findById } from "../../server/models/row-reads.ts";
import { castRow, column, findInBatches, quoteName, selectRows, table } from "../../server/models/sql.ts";
import { isValidEmailFormat } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
const AUDIENCE_PURCHASE_STATES = ["successful", "gift_receiver_purchase_successful", "not_charged"];

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

// `includes(:affiliate_user).where(users: { email: })` eager loads, so every column of both tables is selected under tN_rM aliases.
function eagerLoadedColumns(): Prisma.Sql {
  const columns = (model: string, alias: string) =>
    Prisma.dmmf.datamodel.models
      .find((m) => m.name === model)!
      .fields.filter((field) => field.kind !== "object")
      .map(
        (field, index) =>
          `${quoteName(model === "User" ? "users" : "affiliates")}.${quoteName(field.name)} AS ${alias}_r${index}`,
      );
  return Prisma.raw([...columns("Affiliate", "t0"), ...columns("User", "t1")].join(", "));
}

// Purchase#should_be_audience_member? for a purchase without a subscription, as far as a query-free check decides it.
const cannotQualify = (purchase: Purchase): boolean =>
  purchase.subscription_id === null &&
  (!purchase.can_contact ||
    purchase.purchase_state === null ||
    !AUDIENCE_PURCHASE_STATES.includes(purchase.purchase_state) ||
    purchase.email === null ||
    !isValidEmailFormat(purchase.email));

async function applyRefresh(member: AudienceMemberRecord, sellerId: bigint, now: () => Date): Promise<void> {
  // The stored address of a row that exists (lowercased), the job's argument for one that does not.
  const email = member.get("email");
  const details: Details = {};
  member.set("details", details as never);

  const seller = await findById("User", sellerId);
  if (seller === null) throw new NoMethodError("undefined method 'sales' for nil");

  const sales = Prisma.sql`${column("purchases", "seller_id")} = ${sellerId} AND ${column("purchases", "email")} = ${email}`;
  await findInBatches<Record<string, unknown>>("purchases", sales, FIND_EACH_BATCH_SIZE, (rows) => {
    for (const row of rows)
      if (!cannotQualify(castRow<Purchase>("Purchase", row)))
        throw new HandBackToRuby("a purchase that could be an audience member");
    return Promise.resolve();
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
    () => Promise.reject(new HandBackToRuby("a direct affiliate of the seller")),
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
