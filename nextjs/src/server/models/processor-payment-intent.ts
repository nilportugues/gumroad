// Port of app/models/processor_payment_intent.rb and Order::ChargeService#save_processor_payment_intent!: the row that ties a
// purchase to the PaymentIntent that charged it.
// Golden: __fixtures__/processor-payment-intent.golden.json (scripts/golden/processor-payment-intent.rb), run by the real service.
import { Prisma, type ProcessorPaymentIntent } from "@prisma/client";

import {
  belongsToRequired,
  setAssociation,
  validatesUniqueness,
  type BelongsTo,
} from "./concerns/rails-validations.ts";
import type { PurchaseRecord } from "./purchase-create.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export type ProcessorPaymentIntentRecord = ModelRecord<ProcessorPaymentIntent>;

export const PROCESSOR_PAYMENT_INTENTS = "processor_payment_intents";
const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};

export const ProcessorPaymentIntents = defineModel<ProcessorPaymentIntent>({
  rubyClass: "ProcessorPaymentIntent",
  prismaModel: "ProcessorPaymentIntent",
  delegate: (tx) => tx.processorPaymentIntent as never,
  validations: [
    belongsToRequired<ProcessorPaymentIntent>(PURCHASE),
    // validates_uniqueness_of :purchase
    validatesUniqueness<ProcessorPaymentIntent>("ProcessorPaymentIntent", PROCESSOR_PAYMENT_INTENTS, "purchase_id"),
    validatesPresenceOf<ProcessorPaymentIntent>(["intent_id"]),
  ],
});

// `purchase.processor_payment_intent` (has_one): the first read loads it
async function intentOf(purchase: PurchaseRecord): Promise<ProcessorPaymentIntentRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`processor_payment_intents`.*")} FROM ${table(PROCESSOR_PAYMENT_INTENTS)} WHERE ${column(PROCESSOR_PAYMENT_INTENTS, "purchase_id")} = ${purchase.get("id")} LIMIT 1`,
  );
  return row ? ProcessorPaymentIntents.load(castRow<ProcessorPaymentIntent>("ProcessorPaymentIntent", row)) : null;
}

// save_processor_payment_intent!(purchase, intent_id): update the purchase's row, else create it.
export async function saveProcessorPaymentIntentBang(
  purchase: PurchaseRecord,
  intentId: string | null,
  options: SaveOptions = {},
): Promise<ProcessorPaymentIntentRecord> {
  let intent = await intentOf(purchase);
  if (intent) {
    intent.set("intent_id", intentId as never);
  } else {
    // create_processor_payment_intent! builds the row with the purchase set as its inverse
    intent = ProcessorPaymentIntents.build({ purchase_id: purchase.get("id"), intent_id: intentId as never });
  }
  setAssociation(intent, "purchase", purchase.get("id"), purchase.attributes as never);
  return ProcessorPaymentIntents.saveBang(intent, options);
}
