// app/sidekiq/fight_dispute_job.rb, with StripeChargeProcessor#fight_chargeback for the submission Node makes: a Stripe charge of one
// purchase, on Gumroad's own account, whose evidence has no file to upload. Everything else past the guards goes back to Rails
// before a Stripe call or a write: a Connect charge (the evidence is sent to the seller's account), a charge of several purchases or
// a service charge, a processor other than Stripe, a subscription (its policy image is the cancellation policy) and any evidence
// with an attached file (each is downloaded from storage and uploaded to Stripe as a file whose id keys the submission).
// Golden: __fixtures__/fight-dispute-job.golden.json (scripts/golden/fight-dispute-job.rb).
import type { Dispute, DisputeEvidence, MerchantAccount, Purchase } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import {
  attachmentAttached,
  DisputeEvidences,
  trackAttachmentReads,
} from "../../server/models/dispute-evidence-writes.ts";
import { windowOpen } from "../../server/models/dispute-evidence.ts";
import { isStripeConnectAccount } from "../../server/models/merchant-account.ts";
import { externalId } from "../../server/models/refund.ts";
import { findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { formattedDateFullMonth } from "../../server/models/user-risk.ts";
import { NotPortedError } from "../../server/models/user.ts";
import {
  ChargeProcessorInvalidRequestError,
  withStripeErrorHandler,
} from "../../server/stripe/charge-processor-errors.ts";
import { Charge, Dispute as StripeDispute } from "../../server/stripe/resources.ts";

import { modelJob } from "./support/job-deps.ts";

// DisputeEvidence::RESOLUTION_REJECTED / RESOLUTION_SUBMITTED
const RESOLUTION_REJECTED = "rejected";
const RESOLUTION_SUBMITTED = "submitted";
const STRIPE_CHARGE_PROCESSOR_ID = "stripe";
// String#truncate(255) keeps 252 characters and an ellipsis.
const ERROR_MESSAGE_LIMIT = 255;
const ELLIPSIS = "...";
const REJECTED_MESSAGE = "This dispute is already closed";
const ALREADY_SUBMITTED_MESSAGE = "maximum number of evidence submissions";

// Object#blank? on a column that holds text or nothing.
const blank = (value: string | null | undefined) => value == null || value.trim() === "";
// String#truncate(255)
const truncate = (message: string) =>
  message.length <= ERROR_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, ERROR_MESSAGE_LIMIT - ELLIPSIS.length)}${ELLIPSIS}`;

function noMethod(method: string): never {
  throw new TypeError(`undefined method '${method}' for nil`);
}

const resolved = (resolution: string, errorMessage?: string) => ({
  resolution,
  ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
});

export const fightDisputeJobWith = modelJob({ min: 1 }, async ([disputeId], deps) => {
  const id = await beforeSideEffects(() => recordIdFrom(disputeId, "Dispute.find"));
  const dispute = await findByIdBang<Dispute>("Dispute", id);
  const row = await findOneBy<DisputeEvidence>("DisputeEvidence", "dispute_id", dispute.id, true);
  if (row === null) throw new TypeError("undefined method 'resolved?' for nil");
  if (row.resolved_at !== null) return;
  // Exact comparison against the deadline: nothing is forwarded before the window closes.
  if (windowOpen(row.seller_contacted_at, deps.now())) return;
  const evidence = DisputeEvidences.load(row);
  // Loaded through `dispute.dispute_evidence`, whose owner key the association writes first.
  evidence.touch("dispute_id");

  // dispute.disputable is `charge || purchase || service_charge`.
  if (dispute.charge_id !== null || (dispute.purchase_id === null && dispute.service_charge_id !== null))
    await beforeSideEffects(() => {
      throw new NotPortedError(
        "FightDisputeJob for a charge or service charge",
        "fight_dispute_job.rb: charge_processor_transaction_id",
      );
    });
  const purchase =
    dispute.purchase_id === null ? null : await findOneBy<Purchase>("Purchase", "id", BigInt(dispute.purchase_id));
  if (purchase === null) noMethod("charge_processor_transaction_id");
  if (purchase.subscription_id !== null)
    await beforeSideEffects(() => {
      throw new NotPortedError("FightDisputeJob for a subscription purchase", "dispute_evidence.rb: policy_image");
    });

  const reject = async (errorMessage: string) => {
    // The save validates the attachments, which Rails reads while it does.
    trackAttachmentReads(evidence);
    await beforeSideEffects(() =>
      DisputeEvidences.updateBang(
        evidence,
        { ...resolved(RESOLUTION_REJECTED, errorMessage), resolved_at: deps.now() },
        { now: deps.now },
      ),
    );
  };

  if (blank(purchase.stripe_transaction_id)) {
    const errorMessage = `Missing charge processor transaction ID on Purchase#${purchase.id}.`;
    notifyError(`FightDisputeJob: ${errorMessage} (dispute_id=${dispute.id})`, {});
    await reject(errorMessage);
    return;
  }

  // ChargeProcessor.fight_chargeback(purchase.charge_processor_id, ...)
  if (purchase.charge_processor_id !== STRIPE_CHARGE_PROCESSOR_ID)
    await beforeSideEffects(() => {
      throw new NotPortedError(
        "FightDisputeJob for a purchase of another processor",
        "charge_processor.rb: fight_chargeback",
      );
    });
  const account =
    purchase.merchant_account_id === null
      ? null
      : await findOneBy<MerchantAccount>("MerchantAccount", "id", BigInt(purchase.merchant_account_id));
  if (account !== null && isStripeConnectAccount(account))
    await beforeSideEffects(() => {
      throw new NotPortedError("FightDisputeJob for a Connect charge", "stripe_charge_processor.rb: fight_chargeback");
    });

  trackAttachmentReads(evidence);
  // Each file is read where Rails reads it while building the request. A Stripe GET before it is harmless to repeat, so a file to
  // upload goes back to Rails here, before the submission and any write.
  const requireNoFile = async (name: string) => {
    if (await attachmentAttached(evidence, name))
      await beforeSideEffects(() => {
        throw new NotPortedError(
          `FightDisputeJob with an attached ${name}`,
          "stripe_charge_processor.rb: create_dispute_evidence_stripe_file",
        );
      });
  };
  const idempotencyKey = `dispute_evidence_${externalId(evidence.get("id"))}`;
  try {
    await withStripeErrorHandler(async () => {
      const charge = await Charge.retrieve(purchase.stripe_transaction_id!);
      await requireNoFile("customer_communication_file");
      await requireNoFile("receipt_image");
      const purchasedAt = evidence.get("purchased_at");
      if (purchasedAt === null) noMethod("to_fs");
      const shippedAt = evidence.get("shipped_at");
      const stripeEvidence = {
        billing_address: evidence.get("billing_address"),
        customer_email_address: evidence.get("customer_email"),
        customer_name: evidence.get("customer_name"),
        customer_purchase_ip: evidence.get("customer_purchase_ip"),
        product_description: evidence.get("product_description"),
        service_date: formattedDateFullMonth(purchasedAt),
        shipping_address: evidence.get("shipping_address"),
        shipping_carrier: evidence.get("shipping_carrier"),
        shipping_date: shippedAt === null ? null : formattedDateFullMonth(shippedAt),
        shipping_tracking_number: evidence.get("shipping_tracking_number"),
        uncategorized_text: [
          `The merchant should win the dispute because:\n${evidence.get("reason_for_winning") ?? ""}`,
          evidence.get("uncategorized_text"),
        ]
          .filter((part) => part !== null)
          .join("\n\n"),
        access_activity_log: evidence.get("access_activity_log"),
        cancellation_policy_disclosure: evidence.get("cancellation_policy_disclosure"),
        refund_policy_disclosure: evidence.get("refund_policy_disclosure"),
        cancellation_rebuttal: evidence.get("cancellation_rebuttal"),
        refund_refusal_explanation: evidence.get("refund_refusal_explanation"),
      };
      await requireNoFile("cancellation_policy_image");
      await requireNoFile("refund_policy_image");
      await StripeDispute.update(
        (charge as { dispute?: string | null }).dispute,
        { evidence: stripeEvidence },
        { idempotencyKey },
      );
    });
  } catch (error) {
    if (!(error instanceof ChargeProcessorInvalidRequestError)) throw error;
    if (error.message.includes(REJECTED_MESSAGE)) {
      await reject(error.message);
    } else if (error.message.includes(ALREADY_SUBMITTED_MESSAGE)) {
      // A retry after an update that reached Stripe but whose response never came back.
      await beforeSideEffects(() =>
        DisputeEvidences.updateBang(
          evidence,
          { ...resolved(RESOLUTION_SUBMITTED, truncate(error.message)), resolved_at: deps.now() },
          { now: deps.now },
        ),
      );
    } else {
      throw error;
    }
    return;
  }
  await DisputeEvidences.updateBang(
    evidence,
    { ...resolved(RESOLUTION_SUBMITTED), resolved_at: deps.now() },
    { now: deps.now },
  );
});
export const fightDisputeJob = fightDisputeJobWith();
