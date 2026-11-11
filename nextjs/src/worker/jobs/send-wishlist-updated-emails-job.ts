// Port of app/sidekiq/send_wishlist_updated_emails_job.rb: once nothing newer than a batch of added products is waiting, each follower
// who joined before them is queued CustomerLowPriorityMailer#wishlist_updated (which stays in Ruby, so the ActiveJob push is built as
// `deliver_later(queue: "low")` builds it), guarded by a SentEmailInfo key per follower and product list, and the wishlist records
// when its followers were last contacted. A wishlist id or product ids that are not Integers or their digits (Rails casts them) hand
// back before any statement; a follower who joined within the same millisecond as a product (Prisma drops the microseconds Rails
// compares) hands back, which the sent keys make safe to re-run.
// Golden: __fixtures__/send-wishlist-updated-emails-job.golden.json (scripts/golden/send-wishlist-updated-emails-job.rb).
import { Prisma, type Wishlist, type WishlistFollower, type WishlistProduct } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { mailerKeyDigest, sentEmailKeyExists, setSentEmailKey } from "../../server/models/sent-email-info.ts";
import { castRow, column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import { Wishlists } from "../../server/models/wishlist.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
const MAILER = "CustomerLowPriorityMailer";
const METHOD = "wishlist_updated";
const PRODUCTS = "wishlist_products";
const FOLLOWERS = "wishlist_followers";

const isCastable = (value: unknown): value is number | string =>
  (typeof value === "number" && Number.isSafeInteger(value)) ||
  (typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

export const sendWishlistUpdatedEmailsJobWith = modelJob({ min: 2 }, async (args, deps, { runtime }) => {
  const [rawWishlistId, rawProductIds] = args;
  if (!isCastable(rawWishlistId)) throw new HandBackToRuby("the wishlist id is not an Integer");
  if (!Array.isArray(rawProductIds) || !rawProductIds.every(isCastable))
    throw new HandBackToRuby("the wishlist product ids are not a list of Integers");
  const productIds: (number | string)[] = rawProductIds;

  const wishlist = Wishlists.load(
    await findByIdBang<Wishlist>("Wishlist", recordIdFrom(rawWishlistId, "Wishlist.find")),
  );
  // `where(id: [])` is answered without a query.
  if (productIds.length === 0) return;

  const wishlistId = wishlist.get("id");
  const alive = Prisma.sql`${column(PRODUCTS, "wishlist_id")} = ${wishlistId} AND ${column(PRODUCTS, "deleted_at")} IS NULL`;
  const inBatch = columnIn(
    PRODUCTS,
    "id",
    productIds.map((id) => BigInt(id)),
  );
  const batchProducts = Prisma.sql`${alive} AND ${inBatch}`;

  const [anyProduct] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(PRODUCTS)} WHERE ${batchProducts} LIMIT 1`,
  );
  if (anyProduct === undefined) return;

  const [maximum] = await selectRows<Record<string, Date | null>>(
    Prisma.sql`SELECT MAX(${column(PRODUCTS, "created_at")}) FROM ${table(PRODUCTS)} WHERE ${batchProducts}`,
  );
  const lastProductAddedAt = Object.values(maximum!)[0]!;

  // wishlist_products_for_email: alive, and newer than the last contact once there was one.
  const lastContactedAt = wishlist.get("followers_last_contacted_at");
  const sinceLastContact = lastContactedAt === null ? Prisma.empty : Prisma.sql` AND (created_at > ${lastContactedAt})`;
  const [newer] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(PRODUCTS)} WHERE ${alive}${sinceLastContact} AND (created_at > ${lastProductAddedAt}) LIMIT 1`,
  );
  // Prisma reads datetime(6) at millisecond precision, so the literals above are rounded down and can match the batch's own last
  // product; Rails would stop here only for a product that is really newer, so Ruby decides.
  if (newer !== undefined)
    throw new HandBackToRuby("a product newer than the batch, or one the rounded timestamp cannot tell apart");

  // The relation loads on the first follower that is not skipped by a sent key, and is reused after that.
  let products: WishlistProduct[] | null = null;
  const loadProducts = async () =>
    (products ??= (
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`wishlist_products`.*")} FROM ${table(PRODUCTS)} WHERE ${batchProducts}`,
      )
    ).map((row) => castRow<WishlistProduct>("WishlistProduct", row)));

  await findInBatches<WishlistFollower>(
    FOLLOWERS,
    Prisma.sql`${column(FOLLOWERS, "wishlist_id")} = ${wishlistId}`,
    FIND_EACH_BATCH_SIZE,
    async (followers) => {
      for (const row of followers) {
        const follower = castRow<WishlistFollower>("WishlistFollower", row);
        const digest = mailerKeyDigest(MAILER, METHOD, follower.id, productIds);
        if (await sentEmailKeyExists(digest)) continue;

        const newProducts = (await loadProducts()).filter((product) => {
          const added = product.created_at.getTime();
          const joined = follower.created_at.getTime();
          // Prisma reads datetime(6) at millisecond precision, so a tie may hide a microsecond Rails sees.
          if (added === joined)
            throw new HandBackToRuby("a follower joined within a millisecond of a product being added");
          return added > joined;
        });
        if (newProducts.length === 0) continue;

        await deliverLater(
          runtime,
          { mailer: MAILER, method: METHOD, args: [Number(follower.id), newProducts.length], queue: "low" },
          mailRoute(MAILER, METHOD),
        );
        // A queue failure must leave this follower retryable.
        await setSentEmailKey(digest, deps.now);
      }
    },
  );

  await Wishlists.updateBang(wishlist, { followers_last_contacted_at: lastProductAddedAt }, { now: deps.now });
});

export const sendWishlistUpdatedEmailsJob = sendWishlistUpdatedEmailsJobWith();
