// Port of app/models/event.rb: the permitted names, flags, validations and the scopes jobs use.
// Not ported: TimestampScopes (app/modules/timestamp_scopes.rb) and the delegated user_external_id.
import { Prisma, type Event } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { column } from "./sql.ts";

export const EVENTS = "events";

// Events with these names are kept forever; others (created only with a user_id) are deleted
// after a while by DeleteOldUnusedEventsWorker.
export const EVENT_PERMITTED_NAMES: readonly string[] = [
  "add_product_mobile_app",
  "audience_callout_dismissal",
  "chargeback",
  "delete_product_mobile_app",
  "edit_product_mobile_app",
  "first_purchase_on_profile_visit",
  "post_view",
  "product_purchase_recovery_click",
  "product_refund_policy_fine_print_view",
  "purchase",
  "refund",
  "service_charge",
  "settlement_declined",
  "social_connect_attempted",
  "social_connect_connected",
  "social_connect_failed",
  "social_connect_hold_released",
  "social_connect_offered",
  "social_connect_reviewed",
];

export const EVENT_NAME_PURCHASE = "purchase";
export const EVENT_NAME_SERVICE_CHARGE = "service_charge";
export const EVENT_NAME_POST_VIEW = "post_view";

// Bit positions are persisted data: never renumber. Stored in visit_id, not flags.
export const EventFlags = defineFlags(
  EVENTS,
  {
    1: "from_profile",
    2: "was_product_recommended",
    3: "is_recurring_subscription_charge",
    4: "manufactured",
    5: "on_custom_domain",
    6: "from_multi_overlay",
    7: "from_seo",
  },
  { column: "visit_id", queryMode: "bit_operator" },
);

export const Events = defineModel<Event>({
  rubyClass: "Event",
  prismaModel: "Event",
  delegate: (tx) => tx.event as never,
  validations: [validatesPresenceOf<Event>(["purchase_id", "link_id"], { if: (record) => record.get("event_name") === EVENT_NAME_PURCHASE })],
});

export const eventNameScope = (name: string) => Prisma.sql`${column(EVENTS, "event_name")} = ${name}`;
