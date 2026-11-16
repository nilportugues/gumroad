// Port of app/models/subscription_event.rb. Rows are only created from Subscription#create_interruption_event
// (subscription-writes.ts), which hands the in-memory subscription over in `ivars.subscription`: Rails'
// has_many sets the inverse, so `subscription` costs no query.
import { Prisma, type Subscription, type SubscriptionEvent, type User } from "@prisma/client";

import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { findById } from "./row-reads.ts";
import { castRow, column, quoteName, selectRows, table } from "./sql.ts";

export const SUBSCRIPTION_EVENTS = "subscription_events";

// enum :event_type, %i[deactivated restarted]
export const SUBSCRIPTION_EVENT_TYPES = { deactivated: 0, restarted: 1 } as const;
export type SubscriptionEventType = keyof typeof SUBSCRIPTION_EVENT_TYPES;
const eventTypeName = (value: number): SubscriptionEventType => (value === SUBSCRIPTION_EVENT_TYPES.restarted ? "restarted" : "deactivated");

type EventRecord = ModelRecord<SubscriptionEvent>;
const parentOf = (event: EventRecord) => event.ivars.subscription as ModelRecord<Subscription> | undefined;

// `subscription.subscription_events.order(:occurred_at, :id).last`
export async function latestSubscriptionEvent(subscriptionId: bigint): Promise<SubscriptionEvent | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(SUBSCRIPTION_EVENTS)}.*`)} FROM ${table(SUBSCRIPTION_EVENTS)} WHERE ${column(SUBSCRIPTION_EVENTS, "subscription_id")} = ${subscriptionId} ORDER BY ${column(SUBSCRIPTION_EVENTS, "occurred_at")} DESC, ${column(SUBSCRIPTION_EVENTS, "id")} DESC LIMIT 1`,
  );
  return row ? castRow<SubscriptionEvent>("SubscriptionEvent", row) : null;
}

const validations: Callback<SubscriptionEvent>[] = [
  {
    name: "belongs_to :subscription (required)",
    run: (event) => {
      if (parentOf(event) === undefined) event.errors.add("subscription", "required");
    },
  },
  {
    // The seller is not an association of the parent, so each event loads it.
    name: "belongs_to :seller (required)",
    async run(event) {
      const seller = await findById<User>("User", event.get("seller_id"));
      if (seller === null) event.errors.add("seller", "required");
    },
  },
  {
    name: "validates :event_type, :occurred_at, presence: true",
    run: (event) => {
      for (const attribute of ["event_type", "occurred_at"] as const) if (isBlank(event.get(attribute))) event.errors.add(attribute, "blank");
    },
  },
  {
    name: "consecutive_event_type_not_duplicated",
    async run(event) {
      const subscription = parentOf(event);
      if (subscription === undefined || event.get("occurred_at") == null) return;
      const latest = await latestSubscriptionEvent(subscription.get("id"));
      if (latest !== null && eventTypeName(latest.event_type) === eventTypeName(event.get("event_type"))) event.errors.add("event_type", "already exists as the latest event type");
    },
  },
];

export const SubscriptionEvents = defineModel<SubscriptionEvent>({
  rubyClass: "SubscriptionEvent",
  prismaModel: "SubscriptionEvent",
  delegate: (tx) => tx.subscriptionEvent as never,
  beforeValidation: [
    {
      name: "assign_seller",
      on: "create",
      run: (event) => {
        event.set("seller_id", parentOf(event)?.get("seller_id") as bigint);
      },
    },
  ],
  validations,
});
