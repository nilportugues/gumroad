// Port of app/sidekiq/process_payment_worker.rb: a payment that is not `processing` is left alone; a processing Stripe payment is paid
// out in Node (StripePayoutProcessor.process_payments). A PayPal mass payment, and a Stripe payout shape Node refuses, are handed back
// as soon as the payment is read, before anything has been written or sent.
// Goldens: __fixtures__/process-payment-worker.golden.json (the processors replaced by a recorder, scripts/golden/process-payment-worker.rb)
// and server/models/__fixtures__/payout-users-service.golden.json (the real Stripe processor, scripts/golden/payout-users-service.rb).
import { type Payment } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { Payments } from "../../server/models/payment.ts";
import { processStripePayment } from "../../server/models/payout-users-service.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";

import { modelJob } from "./support/job-deps.ts";

export const processPaymentWorkerWith = modelJob({ min: 1 }, async ([paymentId], deps) => {
  if (paymentId === null) throw new RecordNotFound("Couldn't find Payment without an ID");
  const payment = await beforeSideEffects(() =>
    findByIdBang<Payment>("Payment", recordIdFrom(paymentId, "Payment.find")),
  );
  if (payment.state !== "processing") return;

  await beforeSideEffects(() => processStripePayment(Payments.load(payment as never), { now: deps.now }));
});

export const processPaymentWorker = processPaymentWorkerWith();
