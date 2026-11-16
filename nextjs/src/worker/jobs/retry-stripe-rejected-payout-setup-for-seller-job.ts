// Port of app/sidekiq/retry_stripe_rejected_payout_setup_for_seller_job.rb up to the first write. Every exit that only reads runs in
// Node: no user, a suspended one, and a seller with no outstanding failure note, including the connected-Stripe and PayPal exits that
// find nothing to abandon. A seller with an outstanding note goes back whole before the first write (the abandonment transaction, the
// retry, the give-up email, the Stripe calls). A note whose json_data is not a hash, or does not parse, makes Rails raise into the job's
// ErrorNotifier rescue, which Node cannot report, so it hands back too.
// Reads follow Rails' order: `has_stripe_account_connected?` (the merchant_migration country read, or the Connect account), then
// `current_payout_processor` (PayPal email and bank account, or native payouts), then the notes.
// Golden: __fixtures__/retry-stripe-rejected-payout-setup-for-seller-job.golden.json
// (scripts/golden/retry-stripe-rejected-payout-setup-for-seller-job.rb), recorded up to the first write.
import { Prisma, type Comment, type User } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../../server/infra/flipper.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { COMMENT_TYPES, COMMENTS } from "../../server/models/comment.ts";
import { jsonGet, toHash } from "../../server/models/concerns/json-data.ts";
import { rubyJsonParse } from "../../server/models/concerns/serialized-columns.ts";
import { gumroadAdminId } from "../../server/models/gumroad-admin-id.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "../../server/models/merchant-account.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { isFlagSet, isSuspended, Users } from "../../server/models/user.ts";
import { nativePayoutsSupported } from "../../server/page-props/signed-in/data.ts";

import { aliveInfo, hasActiveBankAccount, hasPaypalAccount } from "./retry-stripe-jp-address-resync-for-seller-job.ts";
import { FAILURE_NOTE_PREFIXES, isBlankJson } from "./retry-stripe-rejected-payout-setups-job.ts";
import { modelJob } from "./support/job-deps.ts";

const MERCHANT_MIGRATION_FEATURE = "merchant_migration";

// `payout_setup_failure_notes(user)`, with `.order(created_at: :asc)` for `oldest_outstanding_note` and without it for the abandonment.
function failureNotes(userId: bigint, oldestFirst: boolean) {
  const c = (name: string) => column(COMMENTS, name);
  const likes = FAILURE_NOTE_PREFIXES.map((prefix) => Prisma.sql`content LIKE ${`${prefix}%`}`);
  const order = oldestFirst ? Prisma.sql` ORDER BY ${c("created_at")} ASC` : Prisma.empty;
  return selectRows<Comment>(
    Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table(COMMENTS)} WHERE ${c("commentable_id")} = ${userId} AND ${c("commentable_type")} = ${"User"} AND ${c("deleted_at")} IS NULL AND ${c("comment_type")} = ${COMMENT_TYPES.PAYOUT_NOTE} AND ${c("author_id")} = ${gumroadAdminId()} AND (${Prisma.join(likes, " OR ")})${order}`,
  );
}

// `note.json_data["abandoned_at"].blank?`: a blank column or a JSON null is `{}`; anything but a hash raises in Ruby.
function abandonedBlank(note: Comment): boolean {
  const raw = note.json_data;
  if (raw === null || isBlank(raw)) return true;
  let hash;
  try {
    const parsed = rubyJsonParse(raw);
    hash = parsed === null ? null : toHash(parsed);
    if (parsed !== null && hash === null) throw new Error("not a hash");
  } catch {
    throw new HandBackToRuby("json_data of a payout note that is not a hash raises into ErrorNotifier");
  }
  return hash === null || isBlankJson(jsonGet(hash, "abandoned_at"));
}

export const retryStripeRejectedPayoutSetupForSellerJobWith = modelJob({ min: 1, max: 1 }, async ([userId]) => {
  const id = userId === null ? null : await beforeSideEffects(() => recordIdFrom(userId, "User.find_by"));
  const row = await findOneBy<User>("User", "id", id, true);
  if (row === null) return;
  const user = Users.load(row);
  if (isSuspended(user)) return;
  const sellerId = user.get("id");

  // `has_stripe_account_connected?`: `merchant_migration_enabled? && stripe_connect_account.present?`
  let connected = false;
  if (!isFlagSet(user, "check_merchant_account_is_linked")) {
    if (await isFeatureEnabled(MERCHANT_MIGRATION_FEATURE, userActor(sellerId)))
      throw new HandBackToRuby("the Stripe Connect routing country of a seller on merchant_migration is not ported");
  } else {
    connected = (await aliveStripeAccountsOf(sellerId)).some((account) => isStripeConnectAccount(account));
  }

  // `current_payout_processor == PAYPAL`: `(paypal_payout_email.present? && active_bank_account.blank?) || !native_payouts_supported?`
  let paypal = false;
  if (!connected) {
    if (isBlank(user.get("payment_address"))) {
      if (await hasPaypalAccount(sellerId))
        throw new HandBackToRuby("the payout email of a connected PayPal account is not ported");
    } else if (!(await hasActiveBankAccount(sellerId))) {
      paypal = true;
    }
    if (!paypal) {
      const info = await aliveInfo(sellerId);
      paypal = info === null || !nativePayoutsSupported(info);
    }
  }

  // `abandon_stale_notes!` writes the abandonment and a payout note when a note is outstanding, and returns when none is.
  if (connected || paypal) {
    const notes = await failureNotes(sellerId, false);
    if (notes.some((note) => abandonedBlank(note)))
      throw new HandBackToRuby("outstanding payout setup notes are abandoned in a transaction");
    return;
  }

  const notes = await failureNotes(sellerId, true);
  if (notes.some((note) => abandonedBlank(note)))
    throw new HandBackToRuby("an outstanding payout setup note is retried, resolved or given up on");
});

export const retryStripeRejectedPayoutSetupForSellerJob = retryStripeRejectedPayoutSetupForSellerJobWith();
