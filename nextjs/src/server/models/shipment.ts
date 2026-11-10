// app/models/shipment.rb, for ShipmentsController#mark_as_shipped on a purchase that already has its shipment: the tracking URL
// save and the `mark_shipped` transition. Creating a shipment (it needs the product as it was at checkout, through PaperTrail)
// stays in Ruby.
import { Prisma, type Purchase, type Shipment } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";
import { ensureMailerUniqueness } from "./sent-email-info.ts";
import { NotPortedError } from "./user.ts";

export const VALID_TRACKING_LINK_MESSAGE = "must be a full URL beginning with http:// or https://";
export const TRACKING_LINK_MAX_LENGTH = 2083;
const NOT_SHIPPED = "not_shipped";
const SHIPPED = "shipped";
const MAILER = "CustomerLowPriorityMailer";
const MAILER_METHOD = "order_shipped";
const MAILER_QUEUE = "low";
const SIMPLE_TRACKING_LINK = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#][\x21-\x7E]*)?$/u;
// Ruby's String#strip: ASCII whitespace and NUL at either end.
const STRIP = /^[\t\n\v\f\r \0]+|[\t\n\v\f\r \0]+$/gu;

// ActiveSupport's `blank?`: Unicode White_Space only (NUL is not blank).
const UNICODE_BLANK = /^\p{White_Space}*$/u;
// Ruby's [[:cntrl:]] on a UTF-8 string is the Cc category, which includes U+0080-U+009F.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1F\x7F-\x9F]/u;

// Shipment.parsed_tracking_uri's escaping: each non-ASCII character becomes its UTF-8 bytes as uppercase %XX
// (URI::DEFAULT_PARSER.escape), so the parser only ever sees ASCII. The stored and rendered value stays as typed.
export function escapeNonAscii(value: string): string {
  return value.replace(/[^\x00-\x7F]/gu, (character) =>
    Array.from(Buffer.from(character, "utf8"), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

export const isBlank = (value: string): boolean => UNICODE_BLANK.test(value);

// Shipment.display_safe_tracking_link: true or false when the port can tell, null for a URL whose parse it does not model.
export function displaySafeTrackingLink(value: string): boolean | null {
  const normalized = value.replace(STRIP, "");
  if (isBlank(normalized)) return false;
  if (Array.from(normalized).length > TRACKING_LINK_MAX_LENGTH) return false;
  if (CONTROL_CHARACTER.test(normalized)) return false;
  if (SIMPLE_TRACKING_LINK.test(escapeNonAscii(normalized))) return true;
  // Without an http(s) scheme the URI either fails to parse or has the wrong scheme or no host: not a display-safe link.
  if (!/^https?:\/\//iu.test(normalized)) return false;
  return null;
}

const validations: Callback<Shipment>[] = [
  {
    name: "validates presence of purchase",
    async run(record) {
      const purchaseId = record.get("purchase_id");
      const [row] = purchaseId == null ? [] : await selectRows(Prisma.sql`SELECT 1 AS present FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchaseId} LIMIT 1`);
      if (!row) record.errors.add("purchase", "blank");
    },
  },
  {
    name: "tracking_url_must_be_display_safe",
    run(record) {
      const url = record.get("tracking_url");
      if (!record.attributeChanged("tracking_url") || url == null || url === "") return;
      const safe = displaySafeTrackingLink(url);
      if (safe === null) throw new NotPortedError("Shipment.display_safe_tracking_link", "a tracking URL the port cannot parse");
      if (!safe) record.errors.add("tracking_url", VALID_TRACKING_LINK_MESSAGE);
    },
  },
];

export const Shipments = defineModel<Shipment>({
  rubyClass: "Shipment",
  prismaModel: "Shipment",
  delegate: (tx) => tx.shipment as never,
  beforeValidation: [
    {
      name: "strip_tracking_url",
      run(record) {
        const url = record.get("tracking_url");
        if (record.attributeChanged("tracking_url") && url != null && url !== "") record.set("tracking_url", url.replace(STRIP, ""));
      },
    },
  ],
  validations,
  afterUpdate: [
    {
      // purchase.touch
      name: "touch_purchase",
      async run(record, { now }) {
        const at = now?.() ?? new Date();
        await execute(Prisma.sql`UPDATE ${table("purchases")} SET ${column("purchases", "updated_at")} = ${at} WHERE ${column("purchases", "id")} = ${record.get("purchase_id")}`);
      },
    },
  ],
});

export type ShipmentRecord = ModelRecord<Shipment>;

// `purchase.shipment`: has_one with no ORDER BY.
export async function shipmentOf(purchase: Pick<Purchase, "id">): Promise<ShipmentRecord | null> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`shipments`.*")} FROM ${table("shipments")} WHERE ${column("shipments", "purchase_id")} = ${purchase.id} LIMIT 1`);
  return row ? Shipments.load(castRow<Shipment>("Shipment", row)) : null;
}

export const shipped = (shipment: ShipmentRecord) => shipment.get("shipped_at") != null;

// `shipment.mark_shipped!` from not_shipped: the state saved, then `marked_as_shipped!` (shipped_at) and the buyer's email.
export async function markShippedBang(shipment: ShipmentRecord, now: () => Date = () => new Date()): Promise<void> {
  if (shipment.get("ship_state") !== NOT_SHIPPED) throw new NotPortedError("Shipment#mark_shipped!", "a shipment that is not in the not_shipped state");
  await transaction(async () => {
    shipment.set("ship_state", SHIPPED);
    await Shipments.saveBang(shipment, { now });
    await Shipments.updateBang(shipment, { shipped_at: now() }, { now });
    const id = shipment.get("id");
    await ensureMailerUniqueness(MAILER, MAILER_METHOD, [id], async () => {
      await deliverLater(currentJobsRuntime(), { mailer: MAILER, method: MAILER_METHOD, args: [id], queue: MAILER_QUEUE }, mailRoute(MAILER, MAILER_METHOD));
    });
  });
}
