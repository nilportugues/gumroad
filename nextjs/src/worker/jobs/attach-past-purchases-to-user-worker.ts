// Port of app/sidekiq/attach_past_purchases_to_user_worker.rb up to the first purchase to attach. `User.find`, the confirmed-email
// default and the `find_each` over the user's unattached purchases run in Node and finish a user with an empty email or nothing left to
// attach. The first purchase means `attach_to_user_and_card` (writes), which hands back to Rails before any write, as does an id or
// email Rails casts. Golden: __fixtures__/attach-past-purchases-to-user-worker.golden.json
// (scripts/golden/attach-past-purchases-to-user-worker.rb).
import { Prisma, type User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
// Ruby's `blank?` is `/\A[[:space:]]*\z/`: not JavaScript's \s, which lacks U+0085 and adds U+FEFF.
const RUBY_BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

export const attachPastPurchasesToUserWorkerWith = modelJob({ min: 1, max: 2 }, async ([userId, emailArg]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  if (emailArg !== undefined && emailArg !== null && typeof emailArg !== "string") throw new HandBackToRuby("the email is not a string");

  const user = await findByIdBang<User>("User", id);
  // `email ||= user.email if user.confirmed?`: a given email (even an empty one) wins
  const email = typeof emailArg === "string" ? emailArg : user.confirmed_at !== null ? user.email : null;
  if (email === null || RUBY_BLANK.test(email)) return;

  await findInBatches(
    "purchases",
    Prisma.sql`${column("purchases", "email")} = ${email} AND ${column("purchases", "purchaser_id")} IS NULL`,
    FIND_EACH_BATCH_SIZE,
    () => {
      throw new HandBackToRuby("a past purchase is attached to the user");
    },
  );
});
export const attachPastPurchasesToUserWorker = attachPastPurchasesToUserWorkerWith();
