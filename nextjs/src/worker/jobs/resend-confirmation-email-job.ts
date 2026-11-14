// Port of app/sidekiq/resend_confirmation_email_job.rb up to the work that leaves the database. `User.alive.find_by(id:)` and the
// "nothing left to confirm" check run in Node and finish a user who is gone, deleted or already confirmed with no pending address. A
// user with something to confirm needs the SendGrid suppression clearing and `send_confirmation_instructions` (a confirmation token
// write and the mail), which hand back to Rails before any write, as does an id Rails casts.
// Golden: __fixtures__/resend-confirmation-email-job.golden.json (scripts/golden/resend-confirmation-email-job.rb).
import { Prisma, type User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

export const resendConfirmationEmailJobWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.alive.find_by"));
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "deleted_at")} IS NULL AND ${column("users", "id")} = ${id} LIMIT 1`,
  );
  if (!row) return;
  const user = castRow<User>("User", row);
  // `user.confirmed? && user.unconfirmed_email.blank?`
  const confirmed = user.confirmed_at !== null;
  const pendingAddress = (user.unconfirmed_email ?? "").trim() !== "";
  if (confirmed && !pendingAddress) return;
  throw new HandBackToRuby("an account confirmation email to resend");
});
export const resendConfirmationEmailJob = resendConfirmationEmailJobWith();
