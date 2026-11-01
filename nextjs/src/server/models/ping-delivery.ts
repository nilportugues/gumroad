// Port of app/models/ping_delivery.rb. Not ported: #as_props, which needs Purchase#external_id_numeric
// through the purchase association; see models/README.md.
import type { PingDelivery } from "@prisma/client";

import { belongsToRequired } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { isBlank } from "./runtime/validators.ts";

export const PING_DELIVERIES = "ping_deliveries";
// How many rows the seller settings list and the admin lookup show.
export const PING_DELIVERY_MAX_RECENT = 10;

export const PingDeliveries = defineModel<PingDelivery>({
  rubyClass: "PingDelivery",
  prismaModel: "PingDelivery",
  delegate: (tx) => tx.pingDelivery as never,
  validations: [belongsToRequired<PingDelivery>({ name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" })],
});

// The private #outcome the readers show.
export function pingDeliveryOutcome(row: Pick<PingDelivery, "response_code" | "error_class">): string {
  if (row.response_code != null) return `HTTP ${row.response_code}`;
  return isBlank(row.error_class) ? "No response" : row.error_class!;
}
