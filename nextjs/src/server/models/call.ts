// app/models/call.rb, for the one write a seller makes: `call.update!(call_url:)` (CallsController#update). The creation-only
// validation, the reminder emails and the calendar invite (after_create_commit) are not ported; creating a Call stays in Ruby.
import { Prisma, type Call } from "@prisma/client";

import { NotPortedError } from "./user.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";

export const NATIVE_TYPE_CALL = "call";

// `delegate :link, to: :purchase`
async function productNativeType(purchaseId: bigint | null): Promise<string | null> {
  if (purchaseId === null) throw new NotPortedError("Call#link", "a call without a purchase");
  const [row] = await selectRows<{ native_type: string | null }>(
    Prisma.sql`SELECT ${column("links", "native_type")} FROM ${table("links")} INNER JOIN ${table("purchases")} ON ${column("purchases", "link_id")} = ${column("links", "id")} WHERE ${column("purchases", "id")} = ${purchaseId} LIMIT 1`,
  );
  if (!row) throw new NotPortedError("Call#link", "a call whose purchase has no product");
  return row.native_type;
}

const validations: Callback<Call>[] = [
  validatesPresenceOf<Call>(["start_time", "end_time"]),
  {
    name: "start_time_is_before_end_time",
    run(record) {
      const start = record.get("start_time");
      const end = record.get("end_time");
      if (start == null || end == null) return;
      if (start.getTime() >= end.getTime()) record.errors.add("base", "Start time must be before end time.");
    },
  },
  {
    name: "purchase_product_is_call",
    async run(record) {
      if ((await productNativeType(record.get("purchase_id"))) !== NATIVE_TYPE_CALL) record.errors.add("base", "Purchased product must be a call");
    },
  },
];

export const Calls = defineModel<Call>({ rubyClass: "Call", prismaModel: "Call", delegate: (tx) => tx.call as never, validations });
