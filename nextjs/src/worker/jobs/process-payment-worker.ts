// Port of the guard of app/sidekiq/process_payment_worker.rb: a payment that is not `processing` is left alone. A processing one is
// sent to its payout processor (Stripe transfers or a PayPal mass payment), which stays with Rails: the job is handed back as soon as
// the payment is read, before anything has been written or sent.
// Golden: __fixtures__/process-payment-worker.golden.json (scripts/golden/process-payment-worker.rb); the processors were replaced
// by a recorder there.
import { type Payment } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const processPaymentWorkerWith = modelJob({ min: 1 }, async ([paymentId]) => {
  if (paymentId === null) throw new RecordNotFound("Couldn't find Payment without an ID");
  const payment = await beforeSideEffects(() =>
    findByIdBang<Payment>("Payment", recordIdFrom(paymentId, "Payment.find")),
  );
  if (payment.state !== "processing") return;

  throw new HandBackToRuby("PayoutProcessorType#process_payments is not ported");
});

export const processPaymentWorker = processPaymentWorkerWith();
