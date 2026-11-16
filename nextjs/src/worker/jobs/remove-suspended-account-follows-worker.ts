// Port of app/sidekiq/remove_suspended_account_follows_worker.rb up to the first Follower#mark_deleted!: a missing or not suspended
// user, and a suspended one with no live follow (linked to the account, or email-only), finish here. A live follow to delete is
// handed back to Rails before it writes (the soft delete clears confirmed_at and runs the Follower callbacks). Golden:
// __fixtures__/remove-suspended-account-follows-worker.golden.json (scripts/golden/remove-suspended-account-follows-worker.rb).
import { Prisma, type User } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, findInBatches } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
const SUSPENDED_STATES = ["suspended_for_tos_violation", "suspended_for_fraud"];
// String#blank?: nil, or nothing but Unicode whitespace.
const BLANK = /^\p{White_Space}*$/u;

// `Follower.alive.where(...).find_each(&:mark_deleted!)`: the load runs in Rails too, so a live follow is where Node stops.
async function handBackIfLiveFollow(condition: Prisma.Sql) {
  const alive = Prisma.sql`${column("followers", "deleted_at")} IS NULL AND ${condition}`;
  await beforeSideEffects(() =>
    findInBatches("followers", alive, FIND_EACH_BATCH_SIZE, () =>
      Promise.reject(new NotPortedError("Follower#mark_deleted!", "follower.rb (confirmed_at reset, callbacks)")),
    ),
  );
}

export const removeSuspendedAccountFollowsWorkerWith = modelJob({ min: 1 }, async ([userIdArg]) => {
  const userId = await beforeSideEffects(() => recordIdFrom(userIdArg, "User.find_by"));
  const user = await findById<User>("User", userId);
  if (!user || !SUSPENDED_STATES.includes(String(user.user_risk_state))) return;

  await handBackIfLiveFollow(Prisma.sql`${column("followers", "follower_user_id")} = ${userId}`);

  // A nil or blank email must never match (and soft-delete) every email-less follower row.
  if (user.email === null || BLANK.test(user.email)) return;
  await handBackIfLiveFollow(
    Prisma.sql`${column("followers", "follower_user_id")} IS NULL AND ${column("followers", "email")} = ${user.email}`,
  );
});
export const removeSuspendedAccountFollowsWorker = removeSuspendedAccountFollowsWorkerWith();
