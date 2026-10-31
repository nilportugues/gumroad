// Port of app/models/processed_stripe_event.rb, complete.
import { Prisma, type ProcessedStripeEvent } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { column, isRecordNotUnique, selectRows, table } from "./sql.ts";

export const PROCESSED_STRIPE_EVENTS = "processed_stripe_events";

export const ProcessedStripeEvents = defineModel<ProcessedStripeEvent>({
  rubyClass: "ProcessedStripeEvent",
  prismaModel: "ProcessedStripeEvent",
  delegate: (tx) => tx.processedStripeEvent as never,
  validations: [validatesPresenceOf<ProcessedStripeEvent>(["event_id"])],
});

// `ProcessedStripeEvent.processed?(event_id)`
export async function stripeEventProcessed(eventId: string): Promise<boolean> {
  const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(PROCESSED_STRIPE_EVENTS)} WHERE ${column(PROCESSED_STRIPE_EVENTS, "event_id")} = ${eventId} LIMIT 1`);
  return rows.length > 0;
}

// `ProcessedStripeEvent.record!(event_id, event_type:)`: nil (null) when another process won.
export async function recordStripeEvent(eventId: string, eventType: string | null = null) {
  try {
    return await ProcessedStripeEvents.createBang({ event_id: eventId, event_type: eventType });
  } catch (error) {
    if (isRecordNotUnique(error)) return null;
    throw error;
  }
}
